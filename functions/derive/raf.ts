import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

/**
 * Fujifilm RAF files embed a full-size JPEG preview, and the header says exactly
 * where it is:
 *
 *   bytes 0..15    "FUJIFILMCCD-RAW "
 *   bytes 28..59   camera model, NUL-padded
 *   bytes 84..87   uint32 BE — offset of the embedded JPEG
 *   bytes 88..91   uint32 BE — length of the embedded JPEG
 *
 * Verified against an X-T30 III frame: a 31,962,784-byte RAF holds a 5,340,350-byte
 * 4416×2944 JPEG at offset 148. Reading the header and then ranging in on just the
 * preview pulls ~5 MB instead of ~32 MB, which keeps the Lambda well inside its
 * timeout and avoids decoding the Bayer data entirely.
 */

const HEADER_BYTES = 96;
const MAGIC = 'FUJIFILMCCD-RAW';

/** Guards against a corrupt header pointing at an absurd range request. */
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

export interface RafPreview {
  jpeg: Buffer;
  camera?: string;
}

async function readRange(
  s3: S3Client,
  bucket: string,
  key: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }),
  );
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function extractRafPreview(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<RafPreview | null> {
  const header = await readRange(s3, bucket, key, 0, HEADER_BYTES - 1);

  if (header.length < HEADER_BYTES) return null;
  if (header.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) return null;

  const offset = header.readUInt32BE(84);
  const length = header.readUInt32BE(88);

  if (length === 0 || length > MAX_PREVIEW_BYTES) return null;

  const jpeg = await readRange(s3, bucket, key, offset, offset + length - 1);

  // A truncated or mis-located preview is worse than none — it would produce a
  // half-grey derivative that looks like a real photo.
  if (jpeg.readUInt16BE(0) !== 0xffd8) return null;

  const camera = header.subarray(28, 60).toString('latin1').replace(/\0+$/, '').trim();

  return { jpeg, camera: camera || undefined };
}

export const isRaf = (ext: string) => ext.toLowerCase() === 'raf';
