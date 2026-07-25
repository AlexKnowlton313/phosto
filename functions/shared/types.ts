export type PhotoKind = 'image' | 'raw-only';

export interface Folder {
  folderId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  photoCount: number;
  coverPhotoId?: string;
  /** Whether the RAW toggle starts on for the owner's own view. */
  rawVisibleDefault: boolean;
}

export interface Photo {
  folderId: string;
  photoId: string;
  /** Original filename stem, e.g. "XT300024". This is what pairs JPEG with RAW. */
  basename: string;
  kind: PhotoKind;
  takenAt: string;
  uploadedAt: string;
  width?: number;
  height?: number;
  /** Extension of the display original, e.g. "jpg". Absent for raw-only photos. */
  originalExt?: string;
  originalBytes?: number;
  /** Extension of the RAW sidecar, e.g. "RAF". Absent when there is no RAW. */
  rawExt?: string;
  rawBytes?: number;
  hasRaw: boolean;
  /** Set once the derive Lambda has written thumb/medium/large. */
  derivedAt?: string;
  /** Populated from EXIF when available — shown in the lightbox. */
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: string;
  shutter?: string;
  focalLength?: string;
}

export interface Share {
  /** SHA-256 of the token. The token itself is never stored. */
  tokenHash: string;
  folderId: string;
  createdAt: string;
  /** Unix seconds; also the DynamoDB TTL attribute. */
  expiresAt: number;
  allowDownload: boolean;
  allowRaw: boolean;
  label?: string;
}

export const DERIVATIVE_SIZES = {
  thumb: 400,
  medium: 1200,
  large: 2400,
} as const;

export type DerivativeName = keyof typeof DERIVATIVE_SIZES;

/** Extensions we can decode into a web preview. */
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'hif'];

/** Extensions treated as RAW: stored, hidden, never previewed inline. */
export const RAW_EXTS = ['raf', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2'];
