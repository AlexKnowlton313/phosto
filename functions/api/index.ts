import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
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
import { invalidate } from '../shared/invalidate.js';
import {
  DERIVATIVE_SIZES,
  type Folder,
  type Photo,
} from '../shared/types.js';

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

interface Presentation {
  allowDownload: boolean;
  allowRaw: boolean;
  /**
   * Whether derivative URLs need signing.
   *
   * The admin holds a cookie covering the whole `f/*` prefix, so its URLs stay
   * relative and cost nothing — signing a 200-frame grid on every page load would
   * be ~400 RSA operations for a credential the browser already has. A share
   * holds no cookie at all: photos are no longer under a folder prefix, so there
   * is no wildcard that names exactly this roll and each object is granted on its
   * own.
   */
  sign: boolean;
}

/**
 * What a viewer is allowed to see. Originals and RAWs are omitted entirely unless
 * the caller has the matching permission, so their keys never leak.
 */
async function presentPhoto(photo: Photo, opts: Presentation) {
  const names = Object.keys(DERIVATIVE_SIZES) as (keyof typeof DERIVATIVE_SIZES)[];

  // ponytail: signs thumb+large per photo, ~540ms for a 200-frame roll on a 1-vCPU
  // Lambda. Sign `large` on demand if that ever shows — at the cost of one Lambda
  // invocation per lightbox open, where this is one per share.
  const urls = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const key = derivedKey(photo.photoId, name);
        return [name, opts.sign ? await signObjectUrl(key, SHARE_TTL) : `/${key}`];
      }),
    ),
  );

  return {
    photoId: photo.photoId,
    basename: photo.basename,
    takenAt: photo.takenAt,
    width: photo.width,
    height: photo.height,
    ready: Boolean(photo.derivedAt),
    hasRaw: opts.allowRaw && photo.hasRaw,
    canDownload: opts.allowDownload && Boolean(photo.originalExt),
    camera: photo.camera,
    lens: photo.lens,
    iso: photo.iso,
    aperture: photo.aperture,
    shutter: photo.shutter,
    focalLength: photo.focalLength,
    urls,
  };
}

/** The owner always has both permissions on their own library, and a cookie. */
const asAdmin = (photos: Photo[]) =>
  Promise.all(
    photos
      .sort(byTakenAtDesc)
      .map((p) => presentPhoto(p, { allowDownload: true, allowRaw: true, sign: false })),
  );

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
 *
 * Uploads land in the library and in no roll: a photo is owned by nobody, so
 * there is no folder in this path and no membership written. Filing a frame is
 * `PUT /api/folders/<id>/photos`, afterwards and separately.
 */
async function createUploads(event: APIGatewayProxyEventV2) {
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
      photoId,
      basename: base,
      // Provisional. The derive Lambda overwrites this from EXIF when it can.
      takenAt: takenAt ? new Date(takenAt).toISOString() : now,
      uploadedAt: now,
      hasRaw: Boolean(raw),
      originalExt: image ? extensionOf(image.filename) : undefined,
      originalBytes: image?.size,
      rawExt: raw ? extensionOf(raw.filename) : undefined,
      rawBytes: raw?.size,
    };
    // Records before bytes: derive looks a photo up by the id in the key and
    // drops the event if there is no record, so an object landing first gets no
    // derivatives, permanently.
    await db.putPhoto(photo);
    created += 1;

    for (const file of groupFiles) {
      const ext = extensionOf(file.filename);
      const key = isRawExt(ext) ? rawKey(photoId, ext) : originalKey(photoId, ext);

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

  console.log('Uploads issued', { photos: created, objects: uploads.length });
  return json(200, { uploads });
}

/**
 * The share page and its og:image come out of this Lambda and are cached at the
 * edge for `PREVIEW_TTL` with no cookie involved. A cover that has just stopped
 * being viewable — detached from the roll, or deleted — keeps unfurling at 2400px
 * until that expires, through a route that never looks at the photo record.
 *
 * `/s/*` rather than the two exact URLs: the path carries the plaintext token
 * and only its SHA-256 is stored, so they cannot be reconstructed. CloudFront
 * bills a wildcard as one path either way.
 */
const invalidatePreviews = () => invalidate(['/s/*']);

/** Every object a photo owns — what destroying it removes. */
const photoObjectKeys = (photo: Photo) => [
  ...Object.keys(DERIVATIVE_SIZES).map((name) =>
    derivedKey(photo.photoId, name as keyof typeof DERIVATIVE_SIZES),
  ),
  // Photos derived before the middle size was dropped still have one in S3.
  // Listed so deleting leaves no billed orphan behind.
  `${PREFIX_DERIVED}${photo.photoId}/medium.webp`,
  ...(photo.originalExt ? [originalKey(photo.photoId, photo.originalExt)] : []),
  ...(photo.rawExt ? [rawKey(photo.photoId, photo.rawExt)] : []),
];

/**
 * Removes objects and drops them from the edge, together, because they are the
 * same operation seen from two places.
 *
 * Two things were learned once each and then not applied to the other callers.
 * `DeleteObjects` reports per-key failures in the *response* rather than by
 * throwing, so an unchecked partial delete returns success on a frame that is
 * still fully readable. And derivatives carry `immutable, max-age=1y`, so
 * removing the object at the origin does not stop a POP serving the copy it
 * already has to anyone holding a still-valid signed URL for it.
 *
 * Invalidation runs after the check, and is best-effort inside `invalidate`:
 * the bytes are the durable half, and failing a request that mostly succeeded
 * only makes the operator retry a delete that already happened.
 *
 * Only the derivative keys are invalidated, collapsed to one wildcard per photo
 * directory. Originals and RAWs are left out because they are reached by a
 * five-minute signed URL minted for someone already authorised, so a POP copy
 * is not the leak — and `f/<photo>/*` costs one path against CloudFront's
 * 1000-a-month free allowance where the keys under it would cost one each.
 */
async function deleteObjects(keys: string[], what: string) {
  const res = await s3.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  if (res.Errors?.length) {
    throw new HttpError(500, `Could not remove ${res.Errors.length} ${what}; retry`);
  }

  const dirs = new Set(
    keys
      .filter((key) => key.startsWith(PREFIX_DERIVED))
      .map((key) => `/${key.replace(/[^/]+$/, '')}*`),
  );
  await invalidate([...dirs]);
}

/**
 * Destroys the photograph itself — every folder loses it at once.
 *
 * The only route that can remove an image from the library, and deliberately not
 * reachable from inside a roll: a roll holds pointers, so removing a frame from
 * one is `detachPhoto` and costs nothing. That separation is what retired the
 * orphan roll. Deleting a folder used to be able to lose a photograph, so photos
 * had somewhere to fall; now there is nothing to fall out of.
 *
 * `db.deletePhoto` unpicks the memberships first, decrementing each roll's count
 * and dropping any cover that named this frame, so nothing is left listing it.
 */
async function destroyPhoto(photoId: string) {
  const photo = await db.getPhoto(photoId);
  if (!photo) throw new HttpError(404, 'Photo not found');

  // Covers are streamed cookie-free through `/s/<token>/og.webp` and edge-cached,
  // so dropping the record is not enough on its own. `db.deletePhoto` clears the
  // field as it detaches, but only an invalidation stops the preview unfurling in
  // the meantime — so ask before, and act after it has actually gone.
  const memberships = await db.listPhotoMemberships(photoId);
  const folders = await Promise.all(
    memberships.map((m) => db.getFolder(m.folderId)),
  );
  const wasCover = folders.some((f) => f?.coverPhotoId === photoId);

  await deleteObjects(photoObjectKeys(photo), 'object(s)');
  await db.deletePhoto(photoId);
  if (wasCover) await invalidatePreviews();

  return json(204, {});
}

/**
 * Puts photos into a roll, or takes them out. One transaction each, no S3 work.
 *
 * This is the whole of what "move" used to be, and the contrast is the point: a
 * move copied the original into a new prefix, waited for the derive Lambda to
 * rebuild the derivatives there, swept the old keys, and was capped at ten frames
 * because each one was a transaction plus two `CopyObject`s against a 15-second
 * timeout. Membership touches no bytes, so there is no ordering rule, no
 * stranded-object state and no batch cap — the photo never moves, only the
 * pointers at it.
 *
 * Whole batch, one report: a 404 on frame 12 would hide the thirty that worked.
 * `already` counts the no-ops so the client can say "3 were already in this roll"
 * rather than claim it added them.
 */
async function setMembership(
  event: APIGatewayProxyEventV2,
  folderId: string,
  attach: boolean,
) {
  const { photoIds } = parseBody<{ photoIds?: string[] }>(event);
  if (!Array.isArray(photoIds) || !photoIds.length) {
    throw new HttpError(400, 'photoIds[] is required');
  }

  const folder = await db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'Folder not found');

  const changed: string[] = [];
  const already: string[] = [];
  const failed: Array<{ photoId: string; message: string }> = [];

  for (const photoId of new Set(photoIds)) {
    try {
      if (attach) {
        const photo = await db.getPhoto(photoId);
        if (!photo) throw new HttpError(404, 'Photo not found');
        (await db.attachPhoto(folderId, photo) ? changed : already).push(photoId);
      } else {
        (await db.detachPhoto(folder, photoId) ? changed : already).push(photoId);
      }
    } catch (err) {
      console.error('Membership change failed', { photoId, folderId, attach, err });
      failed.push({ photoId, message: (err as Error).message });
    }
  }

  console.log('Membership changed', { folderId, attach, changed, already, failed });
  return json(200, { changed, already, failed });
}

async function createShare(event: APIGatewayProxyEventV2, folderId: string) {
  const folder = await db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'Folder not found');

  const body = parseBody<{
    expiresInDays?: number;
    allowDownload?: boolean;
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
    label: body.label,
  });

  return json(201, {
    url: `https://${DOMAIN}/s/${token}`,
    expiresInDays: days,
    allowDownload: body.allowDownload ?? false,
  });
}

// -------------------------------------------------------------- share handlers

async function openShare(token: string) {
  const share = await db.getShare(hashToken(token));
  if (!share) throw new HttpError(404, 'This link has expired or does not exist');

  const folder = await db.getFolder(share.folderId);
  if (!folder) throw new HttpError(404, 'This link has expired or does not exist');

  // Still building. `photoCount` below reads off the filtered list, which is why
  // the share's count is right for free.
  const photos = (await db.listPhotos(share.folderId))
    .filter((p) => p.derivedAt)
    .sort(byTakenAtDesc);

  // No cookie. A photo is no longer under a folder prefix, so there is no
  // wildcard that names this roll and nothing else — each derivative is granted
  // on its own, which is a tighter capability than the folder-wide cookie this
  // replaces. The trade is that detaching a frame no longer revokes anything
  // already issued: those URLs stop working when they expire, not before.
  return json(200, {
    folder: { name: folder.name, photoCount: photos.length },
    permissions: { allowDownload: share.allowDownload },
    // Shares are JPEG-only, always: RAW never leaves the owner's own view.
    photos: await Promise.all(
      photos.map((p) =>
        presentPhoto(p, {
          allowDownload: share.allowDownload,
          allowRaw: false,
          sign: true,
        }),
      ),
    ),
  });
}

/**
 * Mints a single-object download URL for the original JPEG. There is no RAW
 * counterpart — the route below only matches `original`, so a share has no path
 * to the `raw/` prefix at all.
 */
async function shareDownload(token: string, photoId: string) {
  const share = await db.getShare(hashToken(token));
  if (!share) throw new HttpError(404, 'This link has expired or does not exist');

  if (!share.allowDownload) throw new HttpError(403, 'Download not allowed');

  // Membership is checked here rather than inferred from the photo, because the
  // photo no longer knows which rolls it is in. Without this a share could name
  // any photoId in the library and get an original back.
  const inFolder = (await db.listPhotoMemberships(photoId)).some(
    (m) => m.folderId === share.folderId,
  );
  const photo = inFolder ? await db.getPhoto(photoId) : null;
  // The same 404 as a missing photo, deliberately: a share must not be able to
  // tell "in someone else's roll" from "never existed".
  if (!photo) throw new HttpError(404, 'Photo not found');

  return json(200, await downloadPayload(photo, false));
}

async function downloadPayload(photo: Photo, wantRaw: boolean) {
  const ext = wantRaw ? photo.rawExt : photo.originalExt;
  if (!ext) throw new HttpError(404, wantRaw ? 'No RAW for this photo' : 'No original');

  const key = wantRaw
    ? rawKey(photo.photoId, ext)
    : originalKey(photo.photoId, ext);

  return {
    url: await signObjectUrl(key, DOWNLOAD_TTL),
    // The signed URL is a bare object URL, so the name the browser saves under
    // comes from here rather than from a Content-Disposition override.
    filename: `${photo.basename}.${ext}`,
    expiresIn: DOWNLOAD_TTL,
  };
}

// -------------------------------------------------------------- link previews

/*
 * `/s/*` is served by this Lambda rather than from the bucket, so a share link
 * unfurls with the folder's name and cover instead of the generic static title.
 * A crawler does not run JavaScript, so the tags have to be in the HTML it gets.
 *
 * The cover is streamed through `/s/<token>/og.webp` rather than copied to a
 * public prefix. That keeps `f/` reachable only with a signed cookie, keeps the
 * plaintext token out of every durable store but this request, and lets the
 * preview die with the share instead of outliving it as an orphaned object.
 */

/** Cached at the edge, so a revoked share stops unfurling within five minutes. */
const PREVIEW_TTL = 300;

const escapeAttr = (value: string) =>
  value.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );

/** The share's folder, or null if the link is expired, revoked or bogus. */
async function previewFolder(token: string): Promise<Folder | null> {
  const share = await db.getShare(hashToken(token));
  return share ? await db.getFolder(share.folderId) : null;
}

async function sharePage(token: string): Promise<APIGatewayProxyStructuredResultV2> {
  const folder = await previewFolder(token);

  const tags: string[] = ['<meta property="og:type" content="website">'];
  if (folder) {
    const url = `https://${DOMAIN}/s/${token}`;
    tags.push(
      `<meta property="og:title" content="${escapeAttr(folder.name)}">`,
      `<meta property="og:url" content="${url}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:title" content="${escapeAttr(folder.name)}">`,
    );
    if (folder.coverPhotoId) {
      tags.push(
        `<meta property="og:image" content="${url}/og.webp">`,
        `<meta name="twitter:image" content="${url}/og.webp">`,
      );
    }
  }

  // Read the deployed file rather than embedding one: vite hashes the asset
  // names, so an inlined copy would go stale on the next `npm run deploy`.
  const object = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: 'index.html' }),
  );
  const html = await object.Body!.transformToString();

  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=${PREVIEW_TTL}`,
    },
    body: html.replace('</head>', `${tags.join('')}</head>`),
  };
}

async function shareCover(token: string): Promise<APIGatewayProxyStructuredResultV2> {
  const folder = await previewFolder(token);
  if (!folder?.coverPhotoId) throw new HttpError(404, 'No cover for this share');

  // `large`, not `thumb`. Apple's TN3156 wants an og:image at least 900px wide
  // and warns that the size it renders at varies by device: the 400px thumb is
  // enough for the small preview bubble in Messages on macOS but gets dropped by
  // the full-width card on iOS. `large` is 2400px; a webp that size lands well
  // under both Apple's 10 MB preview budget and the tighter real ceiling here,
  // which is Lambda's 6 MB response cap on the base64 body below.
  const object = await s3
    .send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: derivedKey(folder.coverPhotoId, 'large'),
      }),
    )
    .catch(() => {
      // A cover whose photo was deleted. The roll list degrades the same way.
      throw new HttpError(404, 'No cover for this share');
    });

  return {
    statusCode: 200,
    headers: {
      'content-type': 'image/webp',
      'cache-control': `public, max-age=${PREVIEW_TTL}`,
    },
    body: Buffer.from(await object.Body!.transformToByteArray()).toString('base64'),
    isBase64Encoded: true,
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
      // setExpression only skips `undefined`, so without this an empty or
      // whitespace name writes through and leaves a roll with no title at all.
      // createFolder has always refused one; this is the same rule on update.
      if (patch.name !== undefined && !patch.name?.trim()) {
        throw new HttpError(400, 'name cannot be empty');
      }
      // `shareCover` streams the cover with no cookie at all, so a frame that is
      // not in this roll would be published at 2400px to anyone holding its share
      // URL — through a route that only ever looks at the folder record.
      if (patch.coverPhotoId !== undefined) {
        const inFolder = (await db.listPhotoMemberships(patch.coverPhotoId)).some(
          (m) => m.folderId === folderId,
        );
        if (!inFolder) throw new HttpError(404, 'Photo not found in this roll');
      }
      await db.updateFolder(folderId, {
        name: patch.name?.trim(),
        coverPhotoId: patch.coverPhotoId,
      });
      return json(200, await db.getFolder(folderId));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/folders\/([\w-]+)$/,
    admin: true,
    handle: async (_e, [folderId]) => {
      // No refusal, and nothing to check. This route used to guard twice over —
      // once on the photo count, once on a sweep of the folder's S3 prefixes for
      // objects an interrupted move had stranded — because deleting a folder was
      // the one way this API could still lose a photograph. A folder holds
      // pointers now. `deleteFolder` drops them along with the roll's shares, and
      // every frame stays in the library.
      await db.deleteFolder(folderId);
      return json(204, {});
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/folders\/([\w-]+)\/photos$/,
    admin: true,
    handle: async (_e, [folderId]) =>
      json(200, { photos: await asAdmin(await db.listPhotos(folderId)) }),
  },
  {
    // Attach and detach. Not the same thing as destroying the photograph, which
    // is `DELETE /api/photos/<id>` and is the only route that can lose an image.
    method: 'PUT',
    pattern: /^\/api\/folders\/([\w-]+)\/photos$/,
    admin: true,
    handle: (event, [folderId]) => setMembership(event, folderId, true),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/folders\/([\w-]+)\/photos$/,
    admin: true,
    handle: (event, [folderId]) => setMembership(event, folderId, false),
  },

  // --- the library
  {
    method: 'GET',
    pattern: /^\/api\/photos$/,
    admin: true,
    handle: async () => json(200, { photos: await asAdmin(await db.listLibrary()) }),
  },
  {
    // Uploads go to the library, never to a roll — hence no folder id here.
    method: 'POST',
    pattern: /^\/api\/uploads$/,
    admin: true,
    handle: (event) => createUploads(event),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/photos\/([\w-]+)$/,
    admin: true,
    handle: (_e, [photoId]) => destroyPhoto(photoId),
  },
  {
    method: 'POST',
    pattern: /^\/api\/photos\/([\w-]+)\/(original|raw)$/,
    admin: true,
    handle: async (_e, [photoId, kind]) => {
      const photo = await db.getPhoto(photoId);
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
    pattern: /^\/api\/share\/([\w-]+)\/photos\/([\w-]+)\/original$/,
    admin: false,
    handle: (_e, [token, photoId]) => shareDownload(token, photoId),
  },

  // Not under /api — CloudFront routes the share page itself here so that the
  // HTML a link unfurler receives carries the folder's own OG tags.
  {
    method: 'GET',
    pattern: /^\/s\/([\w-]+)$/,
    admin: false,
    handle: (_e, [token]) => sharePage(token),
  },
  {
    method: 'GET',
    pattern: /^\/s\/([\w-]+)\/og\.webp$/,
    admin: false,
    handle: (_e, [token]) => shareCover(token),
  },
];

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  // HEAD is dispatched as GET: the table has no HEAD entries, and every GET
  // handler here is a read. CloudFront drops the response body for a HEAD before
  // it reaches the client, so the handler needn't know the difference.
  const raw = event.requestContext.http.method;
  const method = raw === 'HEAD' ? 'GET' : raw;
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
