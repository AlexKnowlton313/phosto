import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3Event, S3EventRecord } from 'aws-lambda';
import sharp from 'sharp';
import * as db from '../shared/db.js';
import { derivedKey, parseSourceKey } from '../shared/keys.js';
import { DERIVATIVE_SIZES, type DerivativeName, type Photo } from '../shared/types.js';
import { openImage } from './decode.js';
import { readExif } from './exif.js';
import { extractRafPreview, isRaf } from './raf.js';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME!;

/** Long max-age is safe: derivative keys are immutable once written. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

async function getObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

/**
 * Resolves an uploaded object to the bytes we can actually decode.
 *
 * For a RAW this is the embedded preview rather than the file itself. Returning
 * null means "stored, but no preview possible" — the photo stays in the library and
 * remains downloadable, it just never appears in the grid.
 */
async function loadDecodableBytes(
  key: string,
  ext: string,
  isRawObject: boolean,
): Promise<{ buffer: Buffer; sourceExt: string } | null> {
  if (!isRawObject) return { buffer: await getObject(key), sourceExt: ext };

  if (isRaf(ext)) {
    const preview = await extractRafPreview(s3, BUCKET, key);
    return preview ? { buffer: preview, sourceExt: 'jpg' } : null;
  }

  // CR2/NEF/ARW/DNG also carry previews, but each has its own TIFF-IFD layout.
  // Until those are implemented, such files are stored without a preview.
  console.warn(`No preview extractor for .${ext}; storing without derivatives`, { key });
  return null;
}

async function writeDerivatives(pipeline: sharp.Sharp, photoId: string): Promise<void> {
  const entries = Object.entries(DERIVATIVE_SIZES) as [DerivativeName, number][];

  await Promise.all(
    entries.map(async ([name, size]) => {
      const body = await pipeline
        .clone()
        // Cameras record orientation in EXIF rather than rotating pixels; without
        // this, portrait frames come out sideways.
        .rotate()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: name === 'thumb' ? 72 : 82, effort: 4 })
        .toBuffer();

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: derivedKey(photoId, name),
          Body: body,
          ContentType: 'image/webp',
          CacheControl: CACHE_CONTROL,
        }),
      );
    }),
  );
}

const deleteDerivatives = (photoId: string) =>
  s3.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: {
        Objects: (Object.keys(DERIVATIVE_SIZES) as DerivativeName[]).map((name) => ({
          Key: derivedKey(photoId, name),
        })),
        Quiet: true,
      },
    }),
  );

async function processRecord(record: S3EventRecord): Promise<void> {
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const parsed = parseSourceKey(key);

  if (!parsed) {
    console.warn('Ignoring object outside the source prefixes', { key });
    return;
  }

  const { photoId, ext, isRaw } = parsed;

  const photo = await db.getPhoto(photoId);
  if (!photo) {
    console.warn('No photo record for object; skipping', { key });
    return;
  }

  // A JPEG+RAW pair fires this function twice for the same photo. The JPEG is the
  // better source, so let it win: skip the RAW pass once derivatives exist.
  if (isRaw && photo.originalExt) {
    console.log('Photo has a JPEG sibling; RAW needs no preview', { key });
    return;
  }

  const source = await loadDecodableBytes(key, ext, isRaw);
  if (!source) {
    await db.updatePhoto(photoId, { rawBytes: record.s3.object.size });
    return;
  }

  const pipeline = await openImage(source.buffer, source.sourceExt);

  // EXIF is read from the source bytes rather than from `pipeline`, because a
  // HEIC decodes to raw RGBA with no metadata attached. sharp can read a HEIF
  // container's metadata without being able to decode its pixels, so this works
  // for HEIC, for JPEG, and for the JPEG lifted out of a RAF alike.
  const metadata = await sharp(source.buffer)
    .metadata()
    .catch(() => undefined);

  const exif = readExif(metadata?.exif);
  await writeDerivatives(pipeline, photoId);

  // Decoding a HEIC or a RAF takes seconds while a DELETE takes milliseconds, so
  // the frame can be destroyed while this is still working on it. The sweep that
  // removed its objects then ran *before* these derivatives were written, leaving
  // bytes under a key no record names and nothing left that could find them
  // again. Re-read and take them back out rather than strand them.
  const current = await db.getPhoto(photoId);
  if (!current) {
    console.warn('Photo record gone; discarding derivatives just written', {
      key,
      photoId,
    });
    await deleteDerivatives(photoId);
    return;
  }

  const patch: Partial<Photo> = {
    ...exif,
    derivedAt: new Date().toISOString(),
    [isRaw ? 'rawBytes' : 'originalBytes']: record.s3.object.size,
  };

  // Only let EXIF move takenAt when it actually found a date; otherwise keep the
  // provisional value the upload supplied.
  if (!exif.takenAt) delete patch.takenAt;

  await db.updatePhoto(photoId, patch);

  console.log('Derivatives written', {
    key,
    photoId,
    source: isRaw ? 'raw-embedded-preview' : 'original',
  });
}

export const handler = async (event: S3Event): Promise<void> => {
  const results = await Promise.allSettled(event.Records.map(processRecord));

  const failures = results.filter((r) => r.status === 'rejected');
  for (const failure of failures) {
    console.error('Record failed', (failure as PromiseRejectedResult).reason);
  }

  // Throwing hands the whole batch back for retry. One bad frame should not force
  // its neighbours to be reprocessed, but a silent failure would leave a photo
  // permanently stuck without derivatives — so surface it and let Lambda retry.
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${event.Records.length} records failed`);
  }
};
