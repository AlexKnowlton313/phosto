import { IMAGE_EXTS, RAW_EXTS, type DerivativeName } from './types.js';

export const PREFIX_DERIVED = process.env.PREFIX_DERIVED ?? 'f/';
export const PREFIX_ORIGINALS = process.env.PREFIX_ORIGINALS ?? 'orig/';
export const PREFIX_RAW = process.env.PREFIX_RAW ?? 'raw/';

export const derivedKey = (
  folderId: string,
  photoId: string,
  name: DerivativeName,
) => `${PREFIX_DERIVED}${folderId}/${photoId}/${name}.webp`;

export const originalKey = (folderId: string, photoId: string, ext: string) =>
  `${PREFIX_ORIGINALS}${folderId}/${photoId}.${ext.toLowerCase()}`;

export const rawKey = (folderId: string, photoId: string, ext: string) =>
  `${PREFIX_RAW}${folderId}/${photoId}.${ext.toLowerCase()}`;

/** The resource pattern a share cookie is scoped to. */
export const folderResource = (domain: string, folderId: string) =>
  `https://${domain}/${PREFIX_DERIVED}${folderId}/*`;

/**
 * Parses `orig/<folderId>/<photoId>.<ext>` or `raw/<folderId>/<photoId>.<ext>`.
 * Returns null for anything else, including the derivative prefix.
 */
export function parseSourceKey(key: string): {
  folderId: string;
  photoId: string;
  ext: string;
  isRaw: boolean;
} | null {
  const isRaw = key.startsWith(PREFIX_RAW);
  const prefix = isRaw ? PREFIX_RAW : PREFIX_ORIGINALS;
  if (!isRaw && !key.startsWith(PREFIX_ORIGINALS)) return null;

  const rest = key.slice(prefix.length);
  const match = /^([^/]+)\/([^/.]+)\.([A-Za-z0-9]+)$/.exec(rest);
  if (!match) return null;

  const [, folderId, photoId, ext] = match;
  return { folderId, photoId, ext: ext.toLowerCase(), isRaw };
}

export const extensionOf = (filename: string) =>
  (filename.split('.').pop() ?? '').toLowerCase();

/** Filename without its extension — the key that pairs XT300024.JPG with .RAF. */
export const basenameOf = (filename: string) =>
  filename.replace(/\.[^.]+$/, '').replace(/^.*[/\\]/, '');

export const isRawExt = (ext: string) => RAW_EXTS.includes(ext.toLowerCase());
export const isImageExt = (ext: string) => IMAGE_EXTS.includes(ext.toLowerCase());

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  hif: 'image/heif',
  raf: 'image/x-fuji-raf',
  dng: 'image/x-adobe-dng',
  cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3',
  nef: 'image/x-nikon-nef',
  arw: 'image/x-sony-arw',
  orf: 'image/x-olympus-orf',
  rw2: 'image/x-panasonic-rw2',
};

export const contentTypeFor = (ext: string) =>
  CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
