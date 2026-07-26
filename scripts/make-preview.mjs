#!/usr/bin/env node
/**
 * Builds a local share fixture from a folder of real photos so the gallery can be
 * developed without a deployed stack.
 *
 * Writes derivatives and a share payload to web/public/__preview/, which is
 * gitignored and which vite.config.ts serves for any /api/share/* request. Real
 * frames matter here: placeholder rectangles hide exactly the problems worth
 * catching, like how portrait shots sit in a uniform contact-sheet cell.
 *
 * Usage:
 *   node scripts/make-preview.mjs --src /Volumes/Untitled/DCIM/100_FUJI --name "Cascade Loop"
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import exifReader from 'exif-reader';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'web/public/__preview');

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const src = valueOf('--src');
const name = valueOf('--name', 'Preview roll');
const limit = Number(valueOf('--limit', '24'));

if (!src) {
  console.error('Usage: make-preview.mjs --src <directory> [--name "Roll"] [--limit 24]');
  process.exit(1);
}

const IMAGE = /\.(jpe?g|png|webp)$/i;
const RAW = /\.(raf|dng|cr2|cr3|nef|arw|orf|rw2)$/i;

const entries = readdirSync(src).filter((f) => !f.startsWith('.'));
const rawStems = new Set(
  entries.filter((f) => RAW.test(f)).map((f) => basename(f, extname(f))),
);
const images = entries.filter((f) => IMAGE.test(f)).slice(0, limit);

if (images.length === 0) {
  console.error(`No JPEG/PNG files found in ${src}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const clean = (v) =>
  typeof v === 'string' ? v.replace(/\0/g, '').trim() || undefined : undefined;
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const photos = [];

for (const file of images) {
  const stem = basename(file, extname(file));
  const pipeline = sharp(join(src, file));
  const meta = await pipeline.metadata();

  let exif = {};
  try {
    exif = exifReader(meta.exif);
  } catch {
    // Fixture generation should survive a file with unreadable EXIF.
  }

  const photo = exif.Photo ?? {};
  const image = exif.Image ?? {};

  await pipeline
    .clone()
    .rotate()
    .resize(400, 400, { fit: 'inside' })
    .webp({ quality: 72 })
    .toFile(join(outDir, `${stem}-thumb.webp`));

  await pipeline
    .clone()
    .rotate()
    .resize(2400, 2400, { fit: 'inside' })
    .webp({ quality: 82 })
    .toFile(join(outDir, `${stem}-large.webp`));

  const thumb = await sharp(join(outDir, `${stem}-thumb.webp`)).metadata();
  const shutter = finite(photo.ExposureTime);
  const fNumber = finite(photo.FNumber);
  const focal = finite(photo.FocalLength);

  photos.push({
    photoId: stem,
    basename: stem,
    takenAt:
      photo.DateTimeOriginal instanceof Date
        ? photo.DateTimeOriginal.toISOString()
        : statSync(join(src, file)).mtime.toISOString(),
    width: thumb.width,
    height: thumb.height,
    ready: true,
    hasRaw: rawStems.has(stem),
    canDownload: true,
    camera: [clean(image.Make), clean(image.Model)].filter(Boolean).join(' ') || undefined,
    lens: clean(photo.LensModel),
    iso: finite(photo.ISOSpeedRatings),
    aperture: fNumber ? `f/${Number(fNumber.toFixed(1))}` : undefined,
    shutter: shutter ? (shutter >= 1 ? `${shutter}s` : `1/${Math.round(1 / shutter)}`) : undefined,
    focalLength: focal ? `${Math.round(focal)}mm` : undefined,
    urls: {
      thumb: `/__preview/${stem}-thumb.webp`,
      large: `/__preview/${stem}-large.webp`,
    },
  });
}

writeFileSync(
  join(outDir, 'share.json'),
  JSON.stringify(
    {
      folder: { name, photoCount: photos.length },
      permissions: { allowDownload: true, allowRaw: true },
      photos,
    },
    null,
    2,
  ),
);

console.log(
  `Wrote ${photos.length} frames (${photos.filter((p) => p.hasRaw).length} with RAW) to web/public/__preview/`,
);
console.log('Run `npm run dev --workspace web` and open http://localhost:5173/s/demo');
