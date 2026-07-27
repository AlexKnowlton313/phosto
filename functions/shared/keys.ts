import { IMAGE_EXTS, RAW_EXTS, type DerivativeName } from './types.js';

/**
 * Literals, not environment. The stack pins the same three values for its S3
 * notification filters and CloudFront behaviors, and changing one would orphan
 * every object already stored under it — so there is nothing to configure, only
 * two places that have to agree.
 */
export const PREFIX_DERIVED = 'f/';
export const PREFIX_ORIGINALS = 'orig/';
export const PREFIX_RAW = 'raw/';

/**
 * No folder id in any key. A photo can be in several rolls at once and one set of
 * bytes cannot sit under two prefixes, so a key cannot encode who may read it —
 * the signature does, per object, via `signObjectUrl`.
 */
export const derivedKey = (photoId: string, name: DerivativeName) =>
  `${PREFIX_DERIVED}${photoId}/${name}.webp`;

export const originalKey = (photoId: string, ext: string) =>
  `${PREFIX_ORIGINALS}${photoId}.${ext.toLowerCase()}`;

export const rawKey = (photoId: string, ext: string) =>
  `${PREFIX_RAW}${photoId}.${ext.toLowerCase()}`;

/**
 * Parses `orig/<photoId>.<ext>` or `raw/<photoId>.<ext>`. Returns null for
 * anything else, the derivative prefix included.
 */
export function parseSourceKey(key: string): {
  photoId: string;
  ext: string;
  isRaw: boolean;
} | null {
  const isRaw = key.startsWith(PREFIX_RAW);
  const prefix = isRaw ? PREFIX_RAW : PREFIX_ORIGINALS;
  if (!isRaw && !key.startsWith(PREFIX_ORIGINALS)) return null;

  const rest = key.slice(prefix.length);
  const match = /^([^/.]+)\.([A-Za-z0-9]+)$/.exec(rest);
  if (!match) return null;

  const [, photoId, ext] = match;
  return { photoId, ext: ext.toLowerCase(), isRaw };
}

export const extensionOf = (filename: string) =>
  (filename.split('.').pop() ?? '').toLowerCase();

/** Filename without its extension — the key that pairs XT300024.JPG with .RAF. */
export const basenameOf = (filename: string) =>
  filename.replace(/\.[^.]+$/, '').replace(/^.*[/\\]/, '');

export const isRawExt = (ext: string) => RAW_EXTS.includes(ext.toLowerCase());
export const isImageExt = (ext: string) => IMAGE_EXTS.includes(ext.toLowerCase());
