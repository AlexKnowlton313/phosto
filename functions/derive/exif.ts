import exifReader from 'exif-reader';
import type { Photo } from '../shared/types.js';

type ExifFields = Pick<
  Photo,
  'takenAt' | 'camera' | 'lens' | 'iso' | 'aperture' | 'shutter' | 'focalLength'
>;

/** 1/500 reads better than 0.002; anything at or above a second stays decimal. */
function formatShutter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}`;
}

/**
 * EXIF strings are fixed-width and NUL-padded. An X-T30 III with an adapted lens
 * writes LensModel as 63 NUL bytes, which `.trim()` leaves untouched — so strip
 * NULs explicitly and treat the result as absent when nothing remains.
 */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\0/g, '').trim();
  return cleaned || undefined;
}

/** EXIF rationals divide by zero into NaN, which `typeof` still calls a number. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readExif(exifBuffer: Buffer | undefined): Partial<ExifFields> {
  if (!exifBuffer?.length) return {};

  let tags: ReturnType<typeof exifReader>;
  try {
    tags = exifReader(exifBuffer);
  } catch {
    // Malformed EXIF is common in edited exports; it should never fail an upload.
    return {};
  }

  const photo = tags.Photo ?? {};
  const image = tags.Image ?? {};

  const make = cleanString(image.Make) ?? '';
  const model = cleanString(image.Model) ?? '';
  // "FUJIFILM" + "X-T30 III" should not become "FUJIFILM FUJIFILM X-T30 III".
  const camera = model.startsWith(make) ? model : [make, model].filter(Boolean).join(' ');

  const taken = photo.DateTimeOriginal ?? photo.DateTimeDigitized ?? image.DateTime;
  const shutterSeconds = finiteNumber(photo.ExposureTime);
  const fNumber = finiteNumber(photo.FNumber);
  const focal = finiteNumber(photo.FocalLength);

  const fields: Partial<ExifFields> = {
    takenAt: taken instanceof Date && !Number.isNaN(taken.getTime())
      ? taken.toISOString()
      : undefined,
    camera: camera || undefined,
    lens: cleanString(photo.LensModel),
    iso: finiteNumber(photo.ISOSpeedRatings),
    aperture: fNumber ? `f/${Number(fNumber.toFixed(1))}` : undefined,
    shutter: shutterSeconds ? formatShutter(shutterSeconds) : undefined,
    focalLength: focal ? `${Math.round(focal)}mm` : undefined,
  };

  // Drop empty strings so they don't overwrite good values already on the record.
  for (const key of Object.keys(fields) as (keyof ExifFields)[]) {
    if (fields[key] === undefined || fields[key] === '') delete fields[key];
  }

  return fields;
}
