import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3 } from '@aws-sdk/s3-request-presigner';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import * as db from '../shared/db.js';
import {
  basenameOf,
  contentTypeFor,
  derivedKey,
  extensionOf,
  folderResource,
  isImageExt,
  isRawExt,
  originalKey,
  PREFIX_DERIVED,
  rawKey,
} from '../shared/keys.js';
import {
  clearCookieHeaders,
  cookieHeaders,
  signFolderCookies,
  signObjectUrl,
} from '../shared/signing.js';
import { DERIVATIVE_SIZES, type Folder, type Photo } from '../shared/types.js';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME!;
const DOMAIN = process.env.DOMAIN_NAME!;

const SESSION_TTL = 60 * 60 * 8; // admin cookies, matches the Cognito token life
const SHARE_TTL = 60 * 60 * 12; // viewer cookies; the share itself expires separately
const DOWNLOAD_TTL = 60 * 5; // one-off signed URLs for originals and RAWs
const UPLOAD_TTL = 60 * 60; // presigned PUT, generous enough for a 30MB RAF

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'access',
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

// ----------------------------------------------------------------- http helpers

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (
  status: number,
  body: unknown,
  cookies?: string[],
): APIGatewayProxyStructuredResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
  ...(cookies ? { cookies } : {}),
});

function parseBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

async function requireAdmin(event: APIGatewayProxyEventV2): Promise<void> {
  const header = event.headers.authorization ?? event.headers.Authorization;
  const token = header?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Missing bearer token');
  try {
    await verifier.verify(token);
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
}

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** Photos sort newest-first by capture time, falling back to upload time. */
const byTakenAtDesc = (a: Photo, b: Photo) =>
  (b.takenAt ?? b.uploadedAt).localeCompare(a.takenAt ?? a.uploadedAt);

/**
 * What a viewer is allowed to see. Derivative URLs are relative because the signed
 * cookies already authorise them; originals and RAWs are omitted entirely unless
 * the caller has the matching permission, so their keys never leak.
 */
function presentPhoto(photo: Photo, allowDownload: boolean, allowRaw: boolean) {
  return {
    photoId: photo.photoId,
    basename: photo.basename,
    takenAt: photo.takenAt,
    width: photo.width,
    height: photo.height,
    ready: Boolean(photo.derivedAt),
    hasRaw: allowRaw && photo.hasRaw,
    canDownload: allowDownload && Boolean(photo.originalExt),
    camera: photo.camera,
    lens: photo.lens,
    iso: photo.iso,
    aperture: photo.aperture,
    shutter: photo.shutter,
    focalLength: photo.focalLength,
    urls: Object.fromEntries(
      (Object.keys(DERIVATIVE_SIZES) as (keyof typeof DERIVATIVE_SIZES)[]).map(
        (name) => [name, `/${derivedKey(photo.folderId, photo.photoId, name)}`],
      ),
    ),
  };
}

// -------------------------------------------------------------- admin handlers

async function createFolder(event: APIGatewayProxyEventV2) {
  const { name } = parseBody<{ name?: string }>(event);
  if (!name?.trim()) throw new HttpError(400, 'name is required');

  const now = new Date().toISOString();
  const folder: Folder = {
    folderId: randomUUID(),
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    photoCount: 0,
    rawVisibleDefault: false,
  };
  await db.putFolder(folder);
  return json(201, folder);
}

interface UploadRequestFile {
  filename: string;
  size?: number;
  lastModified?: number;
}

/**
 * Issues presigned PUT URLs for a batch of files.
 *
 * Files are grouped by basename first, so XT300024.JPG and XT300024.RAF become one
 * photo with two objects rather than two unrelated photos. That grouping is the
 * whole reason uploads are requested as a batch instead of one file at a time.
 */
async function createUploads(event: APIGatewayProxyEventV2, folderId: string) {
  const folder = await db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'Folder not found');

  const { files } = parseBody<{ files?: UploadRequestFile[] }>(event);
  if (!files?.length) throw new HttpError(400, 'files[] is required');
  if (files.length > 200) throw new HttpError(400, 'Batch limited to 200 files');

  const groups = new Map<string, UploadRequestFile[]>();
  for (const file of files) {
    const base = basenameOf(file.filename);
    const ext = extensionOf(file.filename);
    if (!isImageExt(ext) && !isRawExt(ext)) {
      throw new HttpError(400, `Unsupported file type: ${file.filename}`);
    }
    groups.set(base, [...(groups.get(base) ?? []), file]);
  }

  const now = new Date().toISOString();
  const uploads: Array<{ filename: string; url: string; photoId: string }> = [];
  let created = 0;

  for (const [base, groupFiles] of groups) {
    const image = groupFiles.find((f) => isImageExt(extensionOf(f.filename)));
    const raw = groupFiles.find((f) => isRawExt(extensionOf(f.filename)));
    const photoId = randomUUID();

    const takenAt = groupFiles.find((f) => f.lastModified)?.lastModified;

    const photo: Photo = {
      folderId,
      photoId,
      basename: base,
      kind: image ? 'image' : 'raw-only',
      // Provisional. The derive Lambda overwrites this from EXIF when it can.
      takenAt: takenAt ? new Date(takenAt).toISOString() : now,
      uploadedAt: now,
      hasRaw: Boolean(raw),
      originalExt: image ? extensionOf(image.filename) : undefined,
      originalBytes: image?.size,
      rawExt: raw ? extensionOf(raw.filename) : undefined,
      rawBytes: raw?.size,
    };
    await db.putPhoto(photo);
    created += 1;

    for (const file of groupFiles) {
      const ext = extensionOf(file.filename);
      const key = isRawExt(ext)
        ? rawKey(folderId, photoId, ext)
        : originalKey(folderId, photoId, ext);

      uploads.push({
        filename: file.filename,
        photoId,
        url: await presignS3(
          s3,
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            ContentType: contentTypeFor(ext),
          }),
          { expiresIn: UPLOAD_TTL },
        ),
      });
    }
  }

  await db.bumpPhotoCount(folderId, created);
  return json(200, { uploads });
}

async function deletePhotoAndObjects(folderId: string, photoId: string) {
  const photo = await db.findPhoto(folderId, photoId);
  if (!photo) throw new HttpError(404, 'Photo not found');

  const keys = [
    ...Object.keys(DERIVATIVE_SIZES).map((name) =>
      derivedKey(folderId, photoId, name as keyof typeof DERIVATIVE_SIZES),
    ),
    ...(photo.originalExt ? [originalKey(folderId, photoId, photo.originalExt)] : []),
    ...(photo.rawExt ? [rawKey(folderId, photoId, photo.rawExt)] : []),
  ];

  await s3.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  await db.deletePhoto(photo);
  await db.bumpPhotoCount(folderId, -1);

  return json(204, {});
}

async function createShare(event: APIGatewayProxyEventV2, folderId: string) {
  const folder = await db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'Folder not found');

  const body = parseBody<{
    expiresInDays?: number;
    allowDownload?: boolean;
    allowRaw?: boolean;
    label?: string;
  }>(event);

  const days = Math.min(Math.max(body.expiresInDays ?? 30, 1), 365);

  // 32 bytes of entropy, base64url. This value is returned exactly once and only
  // its hash is persisted, so a leaked table does not yield working links.
  const token = randomBytes(32).toString('base64url');
  const now = new Date();

  await db.putShare({
    tokenHash: hashToken(token),
    folderId,
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + days * 86400,
    allowDownload: body.allowDownload ?? false,
    allowRaw: body.allowRaw ?? false,
    label: body.label,
  });

  return json(201, {
    url: `https://${DOMAIN}/s/${token}`,
    expiresInDays: days,
    allowDownload: body.allowDownload ?? false,
    allowRaw: body.allowRaw ?? false,
  });
}

// -------------------------------------------------------------- share handlers

async function openShare(token: string) {
  const share = await db.getShare(hashToken(token));
  if (!share) throw new HttpError(404, 'This link has expired or does not exist');

  const folder = await db.getFolder(share.folderId);
  if (!folder) throw new HttpError(404, 'This link has expired or does not exist');

  const photos = (await db.listPhotos(share.folderId))
    .filter((p) => p.derivedAt) // hide photos whose derivatives are still building
    .sort(byTakenAtDesc);

  const cookies = await signFolderCookies(
    folderResource(DOMAIN, share.folderId),
    SHARE_TTL,
  );

  return json(
    200,
    {
      folder: { name: folder.name, photoCount: photos.length },
      permissions: { allowDownload: share.allowDownload, allowRaw: share.allowRaw },
      photos: photos.map((p) =>
        presentPhoto(p, share.allowDownload, share.allowRaw),
      ),
    },
    cookieHeaders(cookies, SHARE_TTL),
  );
}

/**
 * Mints a single-object download URL. `wantRaw` decides which permission gate and
 * which prefix applies — the two are checked together so a share that allows JPEG
 * downloads can never be walked into a RAW download.
 */
async function shareDownload(token: string, photoId: string, wantRaw: boolean) {
  const share = await db.getShare(hashToken(token));
  if (!share) throw new HttpError(404, 'This link has expired or does not exist');

  if (wantRaw && !share.allowRaw) throw new HttpError(403, 'RAW download not allowed');
  if (!wantRaw && !share.allowDownload) throw new HttpError(403, 'Download not allowed');

  const photo = await db.findPhoto(share.folderId, photoId);
  if (!photo) throw new HttpError(404, 'Photo not found');

  return json(200, await downloadPayload(photo, wantRaw));
}

async function downloadPayload(photo: Photo, wantRaw: boolean) {
  const ext = wantRaw ? photo.rawExt : photo.originalExt;
  if (!ext) throw new HttpError(404, wantRaw ? 'No RAW for this photo' : 'No original');

  const key = wantRaw
    ? rawKey(photo.folderId, photo.photoId, ext)
    : originalKey(photo.folderId, photo.photoId, ext);

  return {
    url: await signObjectUrl(key, DOWNLOAD_TTL, `${photo.basename}.${ext}`),
    expiresIn: DOWNLOAD_TTL,
  };
}

// ---------------------------------------------------------------------- router

const routes: Array<{
  method: string;
  pattern: RegExp;
  admin: boolean;
  handle: (
    event: APIGatewayProxyEventV2,
    params: string[],
  ) => Promise<APIGatewayProxyStructuredResultV2>;
}> = [
  // --- admin
  {
    method: 'POST',
    pattern: /^\/api\/session$/,
    admin: true,
    handle: async () => {
      // The admin sees every folder, so the policy covers the whole prefix rather
      // than a single folder's.
      const cookies = await signFolderCookies(
        `https://${DOMAIN}/${PREFIX_DERIVED}*`,
        SESSION_TTL,
      );
      return json(200, { ok: true }, cookieHeaders(cookies, SESSION_TTL));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/logout$/,
    admin: false,
    handle: async () => json(200, { ok: true }, clearCookieHeaders()),
  },
  {
    method: 'GET',
    pattern: /^\/api\/folders$/,
    admin: true,
    handle: async () => json(200, { folders: await db.listFolders() }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/folders$/,
    admin: true,
    handle: (event) => createFolder(event),
  },
  {
    method: 'GET',
    pattern: /^\/api\/folders\/([\w-]+)$/,
    admin: true,
    handle: async (_e, [folderId]) => {
      const folder = await db.getFolder(folderId);
      if (!folder) throw new HttpError(404, 'Folder not found');
      return json(200, folder);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/folders\/([\w-]+)$/,
    admin: true,
    handle: async (event, [folderId]) => {
      const patch = parseBody<Partial<Folder>>(event);
      await db.updateFolder(folderId, {
        name: patch.name,
        coverPhotoId: patch.coverPhotoId,
        rawVisibleDefault: patch.rawVisibleDefault,
      });
      return json(200, await db.getFolder(folderId));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/folders\/([\w-]+)$/,
    admin: true,
    handle: async (_e, [folderId]) => {
      const photos = await db.listPhotos(folderId);
      if (photos.length > 0) {
        throw new HttpError(409, `Folder still holds ${photos.length} photos`);
      }
      await db.deleteFolder(folderId);
      return json(204, {});
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/folders\/([\w-]+)\/photos$/,
    admin: true,
    handle: async (_e, [folderId]) => {
      const photos = (await db.listPhotos(folderId)).sort(byTakenAtDesc);
      // The owner always has both permissions on their own library.
      return json(200, { photos: photos.map((p) => presentPhoto(p, true, true)) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/folders\/([\w-]+)\/uploads$/,
    admin: true,
    handle: (event, [folderId]) => createUploads(event, folderId),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/folders\/([\w-]+)\/photos\/([\w-]+)$/,
    admin: true,
    handle: (_e, [folderId, photoId]) => deletePhotoAndObjects(folderId, photoId),
  },
  {
    method: 'POST',
    pattern: /^\/api\/folders\/([\w-]+)\/photos\/([\w-]+)\/(original|raw)$/,
    admin: true,
    handle: async (_e, [folderId, photoId, kind]) => {
      const photo = await db.findPhoto(folderId, photoId);
      if (!photo) throw new HttpError(404, 'Photo not found');
      return json(200, await downloadPayload(photo, kind === 'raw'));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/folders\/([\w-]+)\/shares$/,
    admin: true,
    handle: async (_e, [folderId]) => {
      const shares = await db.listSharesForFolder(folderId);
      // tokenHash is not secret, but there is no reason to hand it out either.
      return json(200, {
        shares: shares.map(({ tokenHash, ...rest }) => ({
          ...rest,
          id: tokenHash.slice(0, 12),
        })),
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/folders\/([\w-]+)\/shares$/,
    admin: true,
    handle: (event, [folderId]) => createShare(event, folderId),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/folders\/([\w-]+)\/shares\/([0-9a-f]{12})$/,
    admin: true,
    handle: async (_e, [folderId, shortId]) => {
      const shares = await db.listSharesForFolder(folderId);
      const match = shares.find((s) => s.tokenHash.startsWith(shortId));
      if (!match) throw new HttpError(404, 'Share not found');
      await db.deleteShare(match.tokenHash);
      return json(204, {});
    },
  },

  // --- public
  {
    method: 'GET',
    pattern: /^\/api\/share\/([\w-]+)$/,
    admin: false,
    handle: (_e, [token]) => openShare(token),
  },
  {
    method: 'POST',
    pattern: /^\/api\/share\/([\w-]+)\/photos\/([\w-]+)\/(original|raw)$/,
    admin: false,
    handle: (_e, [token, photoId, kind]) =>
      shareDownload(token, photoId, kind === 'raw'),
  },
];

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '') || '/';

  try {
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;

      if (route.admin) await requireAdmin(event);
      return await route.handle(event, match.slice(1));
    }
    return json(404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof HttpError) {
      return json(err.status, { error: err.message });
    }
    console.error('Unhandled error', { path, method, err });
    return json(500, { error: 'Internal error' });
  }
};
