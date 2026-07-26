import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  DeleteObjectsCommand,
  ListObjectsV2Command,
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
  folderResource,
  isImageExt,
  isRawExt,
  originalKey,
  PREFIX_DERIVED,
  PREFIX_ORIGINALS,
  PREFIX_RAW,
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
  ORPHAN_FOLDER_ID,
  ORPHAN_FOLDER_NAME,
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
    hidden: photo.hidden,
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
        (name) => [
          name,
          `/${derivedKey(photo.folderId, photo.photoId, name, photo.hidden)}`,
        ],
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

/**
 * The share page and its og:image come out of this Lambda and are cached at the
 * edge for `PREVIEW_TTL` with no cookie involved. A cover that has just stopped
 * being viewable — hidden, moved, deleted — therefore keeps unfurling at 2400px
 * until that expires, through a route that never looks at the photo record.
 *
 * `/s/*` rather than the two exact URLs: the path carries the plaintext token
 * and only its SHA-256 is stored, so they cannot be reconstructed. CloudFront
 * bills a wildcard as one path either way.
 */
const invalidatePreviews = () => invalidate(['/s/*']);

/** Drops the roll's cover if this photo is it. True when it actually cleared. */
async function clearCoverIfSet(folderId: string, photoId: string): Promise<boolean> {
  const folder = await db.getFolder(folderId);
  if (folder?.coverPhotoId !== photoId) return false;
  await db.clearCover(folderId);
  return true;
}

/** Every object a photo owns under one folder — what delete removes and what a
 * move leaves behind at the source. */
const photoObjectKeys = (folderId: string, photo: Photo) => [
  // Off the record rather than a parameter: a hidden photo's derivatives are
  // under `f/hidden/`, and every caller here already holds the item — so delete
  // and a move's source cleanup both follow the flag without being told to.
  ...Object.keys(DERIVATIVE_SIZES).map((name) =>
    derivedKey(
      folderId,
      photo.photoId,
      name as keyof typeof DERIVATIVE_SIZES,
      photo.hidden,
    ),
  ),
  // Photos derived before the middle size was dropped still have one in S3, and
  // always at the visible key — hiding deletes that one rather than moving it,
  // since nothing renders it. Listed so deleting leaves no billed orphan behind.
  `${PREFIX_DERIVED}${folderId}/${photo.photoId}/medium.webp`,
  ...(photo.originalExt
    ? [originalKey(folderId, photo.photoId, photo.originalExt)]
    : []),
  ...(photo.rawExt ? [rawKey(folderId, photo.photoId, photo.rawExt)] : []),
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
 * already has — while a share cookie scoped to `f/<folderId>/*` keeps covering
 * that URL, and reopening the link mints a fresh one. Hiding, moving out of a
 * shared roll and deleting are all the same read at the edge.
 *
 * Invalidation runs after the check, and is best-effort inside `invalidate`:
 * the bytes are the durable half, and failing a request that mostly succeeded
 * only makes the operator retry a delete that already happened.
 *
 * Only the derivative keys are invalidated, collapsed to one wildcard per photo
 * directory. Originals and RAWs are left out because they are reached by a
 * five-minute signed URL minted for someone already authorised, so a POP copy
 * is not the leak — and `f/<folder>/<photo>/*` costs one path against
 * CloudFront's 1000-a-month free allowance where the four keys under it would
 * cost four. That difference is what orphaning a 200-frame roll turns on.
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

async function deletePhotoAndObjects(folderId: string, photoId: string) {
  const photo = await db.findPhoto(folderId, photoId);
  if (!photo) throw new HttpError(404, 'Photo not found');

  // Before the objects, for the same reason `setPhotoHidden` clears it first: a
  // cover is streamed cookie-free through `/s/<token>/og.webp`, and a throw
  // below must not leave the roll advertising a frame that is on its way out.
  if (await clearCoverIfSet(folderId, photoId)) await invalidatePreviews();

  await deleteObjects(photoObjectKeys(folderId, photo), 'object(s)');
  await db.deletePhoto(photo);
  await db.bumpPhotoCount(folderId, -1);

  return json(204, {});
}

/**
 * Moves one photo, record first and objects after.
 *
 * The move is physical because the key path *is* the authorization boundary: a
 * share cookie is signed for `f/<folderId>/*`, so a record that merely claimed a
 * new folder would stay readable by a stale share on the old one and stay
 * invisible to a share on the new one, with the API looking correct throughout.
 *
 * The order is the whole trick and cannot be rearranged:
 *
 * 1. The record moves first. Derive drops an event whose photo it cannot find
 *    (`findPhoto` returns null) and nothing retries it, so an object landing
 *    ahead of its record arrives with no derivatives, permanently.
 * 2. Copying the original into the destination prefix retriggers derive at the
 *    new key, which is what rebuilds `f/<dst>/…`. The derivatives are therefore
 *    never copied by hand. The RAW copy after it returns immediately for a
 *    paired photo and re-extracts the preview for a RAW-only one.
 * 3. The old keys go last, derivatives included.
 *
 * Every step logs both keys: if this dies mid-flight the photo is stuck as
 * DEVELOPING in the destination, and the repair is the documented re-derive
 * copy — which needs to know where the original actually is right now.
 */
async function movePhotoAndObjects(
  source: Folder,
  photoId: string,
  toFolderId: string,
) {
  const photo = await db.findPhoto(source.folderId, photoId);
  if (!photo) throw new HttpError(404, 'Photo not found');

  await db.movePhoto(source, photo, toFolderId);
  console.log('Moved photo record', {
    photoId,
    from: source.folderId,
    to: toFolderId,
  });

  for (const [from, to] of [
    ...(photo.originalExt
      ? [
          [
            originalKey(source.folderId, photoId, photo.originalExt),
            originalKey(toFolderId, photoId, photo.originalExt),
          ],
        ]
      : []),
    ...(photo.rawExt
      ? [
          [
            rawKey(source.folderId, photoId, photo.rawExt),
            rawKey(toFolderId, photoId, photo.rawExt),
          ],
        ]
      : []),
  ]) {
    // CopyObject reads Glacier Instant Retrieval without a restore step, so an
    // aged RAF moves like any other object — the copy just lands in Standard
    // and starts its own 30-day clock.
    await s3.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `${BUCKET}/${from}`,
        Key: to,
      }),
    );
    console.log('Copied object', { photoId, from, to });
  }

  const stale = photoObjectKeys(source.folderId, photo);
  await deleteObjects(stale, 'source object(s)');
  console.log('Deleted source objects', { photoId, keys: stale, to: toFolderId });

  // The transaction above drops the cover when the moved frame was it, so the
  // roll's link preview is now pointing at a folder that no longer holds it.
  if (source.coverPhotoId === photoId) await invalidatePreviews();
}

/**
 * Hides or unhides one frame, moving its derivatives between `f/<folder>/…` and
 * `f/hidden/<folder>/…`.
 *
 * A boolean filtered out of `openShare` would not have been enough. The reason
 * to hide a frame is almost always that it was already shared, and that viewer's
 * browser is holding the derivative URL — in history, in cache, in an open tab.
 * A list filter leaves that URL working, and re-opening the share link mints a
 * fresh cookie for the whole folder prefix. Moving the bytes revokes it.
 *
 * Copy, flip, delete — the OPPOSITE order from `movePhotoAndObjects`, and for a
 * reason that does not generalise. A move needs the record ahead of the bytes
 * because derive drops an event whose photo it cannot find. Nothing re-derives
 * here: the flag is the only thing pointing at these keys, so it must not be
 * flipped until the bytes it names exist. Both copies are live in between, so
 * neither the grid nor an open share renders a hole mid-flight.
 */
async function setPhotoHidden(
  event: APIGatewayProxyEventV2,
  folderId: string,
  photoId: string,
) {
  const { hidden } = parseBody<{ hidden?: boolean }>(event);
  if (typeof hidden !== 'boolean') throw new HttpError(400, 'hidden must be a boolean');

  const folder = await db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'Folder not found');

  const photo = await db.findPhoto(folderId, photoId);
  if (!photo) throw new HttpError(404, 'Photo not found');

  const names = Object.keys(DERIVATIVE_SIZES) as Array<keyof typeof DERIVATIVE_SIZES>;

  // Before the S3 work, not after. `shareCover` streams the cover through
  // `/s/<token>/og.webp` with no cookie at all, so a throw further down must not
  // leave a hidden frame still named as the roll's cover. Clearing the record is
  // not enough on its own — that response is edge-cached, hence the second call.
  if (hidden && (await clearCoverIfSet(folderId, photoId))) await invalidatePreviews();

  // Deliberately not guarded on the flag actually changing. Every step below is
  // idempotent, and a retry is the only repair available when a previous attempt
  // flipped the flag and then failed to move the bytes — which would otherwise
  // leave the record claiming hidden while the share prefix still served it, a
  // state no amount of re-clicking Hide could fix.
  const stale = names.map((name) => derivedKey(folderId, photoId, name, !hidden));

  for (const name of names) {
    await s3
      .send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          CopySource: `${BUCKET}/${derivedKey(folderId, photoId, name, !hidden)}`,
          Key: derivedKey(folderId, photoId, name, hidden),
        }),
      )
      .catch((err: { name?: string }) => {
        // Nothing at the source is the normal case twice over: a frame still
        // DEVELOPING has no derivatives yet, and a retry finds them already moved.
        if (err.name !== 'NoSuchKey') throw err;
      });
  }

  await db.updatePhoto(photo, { hidden });

  if (hidden) {
    // Never moved, only removed. Nothing renders the dropped middle size, but it
    // sits at a key anyone who saw `large.webp` can guess from it, so for a photo
    // old enough to have one it would be the hole this whole move closes.
    stale.push(`${PREFIX_DERIVED}${folderId}/${photoId}/medium.webp`);
  }

  // Checks the per-key failures and invalidates in one place; for hiding, the
  // cached copy at the edge *is* the leak.
  await deleteObjects(stale, 'old derivative(s)');

  console.log('Photo hidden flag set', { photoId, folderId, hidden, stale });

  return json(200, presentPhoto({ ...photo, hidden }, true, true));
}

/**
 * Creates the orphan roll the first time something needs it.
 *
 * Lazily rather than from a bootstrap script: a fresh stack should work with
 * nothing run against it first, and a roll that has never received an orphan is
 * a row in the folder list that only ever confuses. The read-then-write is not
 * atomic, but the id is fixed and the loser of a race rewrites the same item —
 * the only casualty would be a `photoCount` reset, which the moves that follow
 * then re-increment from zero. Nothing about a photo depends on it.
 */
async function ensureOrphanFolder(): Promise<void> {
  if (await db.getFolder(ORPHAN_FOLDER_ID)) return;
  const now = new Date().toISOString();
  await db.putFolder(
    {
      folderId: ORPHAN_FOLDER_ID,
      name: ORPHAN_FOLDER_NAME,
      createdAt: now,
      updatedAt: now,
      photoCount: 0,
    },
    // getFolder is eventually consistent and a plain Put is a whole-item
    // overwrite, so without this a stale read partway through a 12-chunk
    // orphaning re-creates the folder at photoCount 0 and drops its cover.
    // Losing the race is the expected outcome, not an error.
    { ifAbsent: true },
  );
}

/** First key under any prefix the folder owns, or null if it has none. */
async function firstObjectUnder(folderId: string): Promise<string | null> {
  // `f/hidden/<folderId>/` is listed separately because it is not under
  // `f/<folderId>/` — that is the entire point of the hidden prefix, and it also
  // means a plain three-prefix sweep would miss a hidden frame's derivatives.
  for (const prefix of [
    `${PREFIX_DERIVED}${folderId}/`,
    `${PREFIX_DERIVED}hidden/${folderId}/`,
    `${PREFIX_ORIGINALS}${folderId}/`,
    `${PREFIX_RAW}${folderId}/`,
  ]) {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1 }),
    );
    if (res.Contents?.length) return res.Contents[0].Key!;
  }
  return null;
}

/**
 * Whole batch, one report. A 404 for frame 12 would hide the thirty that did
 * move, so every outcome is per photo and the caller decides what to retry —
 * including when the batch is one photo long, so the shape never changes under
 * the client.
 */
async function movePhotos(event: APIGatewayProxyEventV2, folderId: string) {
  const { toFolderId, photoIds } = parseBody<{
    toFolderId?: string;
    photoIds?: string[];
  }>(event);

  if (!toFolderId) throw new HttpError(400, 'toFolderId is required');
  if (toFolderId === folderId) throw new HttpError(400, 'Already in that folder');
  if (!Array.isArray(photoIds) || !photoIds.length) {
    throw new HttpError(400, 'photoIds[] is required');
  }
  // Far below createUploads' 200: that one mints presigned URLs locally, while
  // every photo here is a query, a transaction, up to two CopyObjects and a
  // delete, all serial, against a 15-second Lambda timeout. Ten leaves real
  // headroom: a batch killed mid-loop reports nothing, and a move interrupted
  // between the record and the copy strands bytes under the old prefix.
  if (photoIds.length > 10) throw new HttpError(400, 'Batch limited to 10 photos');

  const source = await db.getFolder(folderId);
  if (!source) throw new HttpError(404, 'Folder not found');
  if (toFolderId === ORPHAN_FOLDER_ID) await ensureOrphanFolder();
  if (!(await db.getFolder(toFolderId))) {
    throw new HttpError(404, 'Destination folder not found');
  }

  const moved: string[] = [];
  const failed: Array<{ photoId: string; message: string }> = [];

  for (const photoId of new Set(photoIds)) {
    try {
      await movePhotoAndObjects(source, photoId, toFolderId);
      moved.push(photoId);
    } catch (err) {
      console.error('Move failed', { photoId, from: folderId, to: toFolderId, err });
      failed.push({ photoId, message: (err as Error).message });
    }
  }

  return json(200, { moved, failed });
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

  const photos = (await db.listPhotos(share.folderId))
    // Still building, or hidden. The hidden ones are unreachable anyway — their
    // bytes are outside this cookie's prefix — so this is only about not showing
    // a viewer a frame-shaped hole. `photoCount` below reads off the filtered
    // list, which is why the share's count is right for free.
    .filter((p) => p.derivedAt && !p.hidden)
    .sort(byTakenAtDesc);

  const cookies = await signFolderCookies(
    folderResource(DOMAIN, share.folderId),
    SHARE_TTL,
  );

  return json(
    200,
    {
      folder: { name: folder.name, photoCount: photos.length },
      permissions: { allowDownload: share.allowDownload },
      // Shares are JPEG-only, always: RAW never leaves the owner's own view.
      photos: photos.map((p) => presentPhoto(p, share.allowDownload, false)),
    },
    cookieHeaders(cookies, SHARE_TTL),
  );
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

  const photo = await db.findPhoto(share.folderId, photoId);
  if (!photo) throw new HttpError(404, 'Photo not found');
  // Originals never move — they are reached by a per-object signed URL, not by
  // the cookie — so this is the one place hiding is enforced in code. The same
  // 404 as a missing photo, deliberately: a share must not be able to tell
  // "hidden" from "never existed".
  if (photo.hidden) throw new HttpError(404, 'Photo not found');

  return json(200, await downloadPayload(photo, false));
}

async function downloadPayload(photo: Photo, wantRaw: boolean) {
  const ext = wantRaw ? photo.rawExt : photo.originalExt;
  if (!ext) throw new HttpError(404, wantRaw ? 'No RAW for this photo' : 'No original');

  const key = wantRaw
    ? rawKey(photo.folderId, photo.photoId, ext)
    : originalKey(photo.folderId, photo.photoId, ext);

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
        Key: derivedKey(folder.folderId, folder.coverPhotoId, 'large'),
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
      // The orphan roll is a fixture, and its name is the only thing telling the
      // owner why photos are sitting in it. A cover is harmless, so only the
      // rename is refused rather than the whole patch.
      if (folderId === ORPHAN_FOLDER_ID && patch.name !== undefined) {
        throw new HttpError(409, 'The orphaned roll cannot be renamed');
      }
      // setExpression only skips `undefined`, so without this an empty or
      // whitespace name writes through and leaves a roll with no title at all.
      // createFolder has always refused one; this is the same rule on update.
      if (patch.name !== undefined && !patch.name?.trim()) {
        throw new HttpError(400, 'name cannot be empty');
      }
      // `shareCover` streams the cover with no cookie at all, so a hidden frame
      // named here would be published at 2400px to anyone holding the share URL
      // — undoing the hide through a route that never looks at the photo record.
      if (patch.coverPhotoId !== undefined) {
        const cover = await db.findPhoto(folderId, patch.coverPhotoId);
        if (!cover) throw new HttpError(404, 'Photo not found');
        if (cover.hidden) throw new HttpError(409, 'A hidden frame cannot be a cover');
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
      // It is where photos go when their roll is deleted, so deleting it is the
      // one way this API could still lose an image.
      if (folderId === ORPHAN_FOLDER_ID) {
        throw new HttpError(409, 'The orphaned roll cannot be deleted');
      }
      const photos = await db.listPhotos(folderId);
      if (photos.length > 0) {
        throw new HttpError(409, `Folder still holds ${photos.length} photos`);
      }
      // An empty photo list is not proof the folder is empty. A move writes the
      // record before it copies the bytes, so a batch killed mid-flight — the
      // Lambda has 15 seconds — leaves records pointing at the destination while
      // the objects sit here. Deleting the folder then removes the last thing
      // naming that prefix, and only `aws s3 ls` can find the frame again.
      const stranded = await firstObjectUnder(folderId);
      if (stranded) {
        throw new HttpError(
          409,
          `Folder still holds objects in S3 (${stranded}); a move may have been interrupted`,
        );
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
    // Per photo, not a batch: each one is two CopyObjects and a delete of a few
    // hundred KB, and the client's bulk hide is a loop of these — so unlike a
    // move, nothing here has to finish inside one 15-second invocation.
    method: 'PATCH',
    pattern: /^\/api\/folders\/([\w-]+)\/photos\/([\w-]+)$/,
    admin: true,
    handle: (event, [folderId, photoId]) => setPhotoHidden(event, folderId, photoId),
  },
  {
    // Bulk only. The plan named a per-photo route too, but multi-select landed
    // first, so `{ photoIds: [one] }` already covers it and a second path would
    // just be a second set of semantics to keep in step.
    method: 'POST',
    pattern: /^\/api\/folders\/([\w-]+)\/photos\/move$/,
    admin: true,
    handle: (event, [folderId]) => movePhotos(event, folderId),
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
