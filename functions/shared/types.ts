export interface Folder {
  folderId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  photoCount: number;
  coverPhotoId?: string;
}

/**
 * A photograph, owned by nobody.
 *
 * There is no `folderId` here and none in any key it names. A photo is a row in
 * one library; a folder is a set of pointers at rows. That is what lets one frame
 * appear in several rolls, and it is why deleting a roll can no longer destroy an
 * image — nothing lives *inside* a folder to be taken down with it.
 */
export interface Photo {
  photoId: string;
  /** Original filename stem, e.g. "XT300024". This is what pairs JPEG with RAW. */
  basename: string;
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
  /** Set once the derive Lambda has written thumb/large. */
  derivedAt?: string;
  /** Populated from EXIF when available — shown in the lightbox. */
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: string;
  shutter?: string;
  focalLength?: string;
}

/**
 * One photo's presence in one folder. The only thing that ties the two together,
 * and cheap enough that a frame can be in as many rolls as you like.
 *
 * `uploadedAt` is carried so the item can sort itself in `gsi1` without a lookup
 * back at the photo, and it is `uploadedAt` rather than `takenAt` because derive
 * corrects `takenAt` from EXIF afterwards and a sort key cannot be updated in
 * place. Callers sort by `takenAt` after reading.
 */
export interface Membership {
  photoId: string;
  folderId: string;
  uploadedAt: string;
}

export interface Share {
  /** SHA-256 of the token. The token itself is never stored. */
  tokenHash: string;
  folderId: string;
  createdAt: string;
  /** Unix seconds; also the DynamoDB TTL attribute. */
  expiresAt: number;
  allowDownload: boolean;
  label?: string;
}

/**
 * Two sizes, not three. `thumb` fills the contact sheet and `large` is what the
 * lightbox renders; a middle size was written for every photo and never displayed
 * by anything, so it was a third of the derive cost and storage for nothing.
 */
export const DERIVATIVE_SIZES = {
  thumb: 400,
  large: 2400,
} as const;

export type DerivativeName = keyof typeof DERIVATIVE_SIZES;

/** Extensions we can decode into a web preview. */
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'hif'];

/** Extensions treated as RAW: stored, hidden, never previewed inline. */
export const RAW_EXTS = ['raf', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2'];
