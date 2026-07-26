import sharp from 'sharp';

/**
 * HEIC/HEIF decoding.
 *
 * sharp's prebuilt binaries do not ship libheif, so `sharp(heicBuffer)` fails on
 * Lambda. libheif-js is the same library compiled to wasm — slower, but it needs no
 * native build and the volume here is a handful of frames per upload batch.
 *
 * The import is dynamic so the far more common JPEG path never pays the cost of
 * instantiating the wasm module.
 */
export async function decodeHeic(buffer: Buffer): Promise<sharp.Sharp> {
  // The `.js` is required, not stylistic: libheif-js declares no "exports" map,
  // so Node's ESM resolver will not resolve the extensionless subpath and fails
  // with ERR_MODULE_NOT_FOUND at decode time — long after deploy looks healthy.
  const { default: libheif } = await import('libheif-js/wasm-bundle.js');

  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(buffer);
  if (!images?.length) throw new Error('HEIF file contains no images');

  // A HEIC may hold a burst; the first image is the primary one.
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();

  const rgba = Buffer.alloc(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    image.display({ data: rgba, width, height }, (result: unknown) =>
      result ? resolve() : reject(new Error('HEIF decode failed')),
    );
  });

  return sharp(rgba, { raw: { width, height, channels: 4 } });
}

const HEIC_EXTS = new Set(['heic', 'heif', 'hif']);
export const isHeic = (ext: string) => HEIC_EXTS.has(ext.toLowerCase());

/** Returns a sharp pipeline for any buffer we know how to decode. */
export async function openImage(
  buffer: Buffer,
  ext: string,
): Promise<sharp.Sharp> {
  if (isHeic(ext)) return decodeHeic(buffer);
  // failOn: 'none' keeps a slightly truncated file usable rather than throwing.
  return sharp(buffer, { failOn: 'none', limitInputPixels: 512_000_000 });
}
