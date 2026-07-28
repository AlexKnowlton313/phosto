export interface AppConfig {
  userPoolId: string;
  userPoolClientId: string;
  domain: string;
}

export interface PhotoView {
  photoId: string;
  basename: string;
  takenAt: string;
  /** When the frame entered the library — how a pending one is told from a stuck one. */
  uploadedAt: string;
  ready: boolean;
  hasRaw: boolean;
  canDownload: boolean;
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: string;
  shutter?: string;
  focalLength?: string;
  /**
   * Relative for the admin, whose signed cookie covers `f/*`; absolute and signed
   * for a share viewer, who holds no cookie and is granted each object on its own.
   * Nothing here needs to know which — both go straight into `<img src>`.
   */
  urls: { thumb: string; large: string };
}

export interface FolderView {
  folderId: string;
  name: string;
  createdAt: string;
  photoCount: number;
  /** Derivative key is `f/<coverPhotoId>/thumb.webp` — no API field needed. */
  coverPhotoId?: string;
  /**
   * Which end of the roll frame 01 is; absent means 'newest'. The share view gets
   * its photos already in this order — the admin applies it to the newest-first
   * list the API returns, so reading a roll costs no extra folder lookup.
   */
  sortOrder?: 'newest' | 'oldest';
}

/**
 * The "All photos" pseudo-roll. Not a folder on the server and never sent to one:
 * the sidebar renders it alongside the real rolls, and every handler that would
 * take a folderId checks for it first. A literal that `randomUUID()` cannot mint,
 * so it can never collide with a real roll's id.
 */
export const LIBRARY_ID = 'all';

/**
 * The "New roll…" option in a roll picker. A sentinel for the same reason as
 * `LIBRARY_ID`: `randomUUID()` cannot mint it, so it can never be a real roll's
 * id. Every picker that offers it does the same thing — prompt for a name,
 * `createFolder`, then attach to the id that comes back.
 */
export const NEW_ROLL = 'new';

/**
 * A live link as the list route returns it: `tokenHash` stripped and replaced by
 * its first 12 hex characters. There is no URL here and there never can be —
 * only the hash is stored.
 */
export interface ShareSummary {
  id: string;
  folderId: string;
  createdAt: string;
  /**
   * Unix seconds; also the DynamoDB TTL attribute. Not ISO, unlike createdAt.
   * Absent on a link that never expires.
   */
  expiresAt?: number;
  allowDownload: boolean;
  label?: string;
  /** Opens of the share page, not viewers: a reload counts again. */
  views?: number;
  lastViewedAt?: string;
}

export interface ShareView {
  folder: { name: string; photoCount: number };
  permissions: { allowDownload: boolean };
  photos: PhotoView[];
}

let cachedConfig: AppConfig | undefined;

/** Written into the bucket by CDK at deploy time, so the bundle stays generic. */
export async function loadConfig(): Promise<AppConfig> {
  if (!cachedConfig) {
    const res = await fetch('/config.json');
    if (!res.ok) throw new Error('Could not load app config');
    cachedConfig = (await res.json()) as AppConfig;
  }
  return cachedConfig;
}

/**
 * Resolved per request rather than bound once: the access token lives 8 hours and
 * a tab outlives it. `currentToken` reads local storage and only touches Cognito
 * when the token has actually expired, so this is a memory read on almost every
 * call and a silent refresh on the one that matters — which is why there is no
 * retry-on-401 anywhere.
 */
export type TokenSource = () => Promise<string | null>;

async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: TokenSource,
): Promise<T> {
  const bearer = await token?.();
  const res = await fetch(path, {
    ...init,
    // Signed cookies are set by the API and read by CloudFront on image requests.
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((payload as { error?: string }).error ?? res.statusText);
  }
  return payload as T;
}

// ------------------------------------------------------------------ admin API

export const adminApi = (token: TokenSource) => ({
  startSession: () => request<{ ok: true }>('/api/session', { method: 'POST' }, token),

  /** Expires the signed image cookies. Cognito sign-out alone leaves them live. */
  endSession: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),

  listFolders: () => request<{ folders: FolderView[] }>('/api/folders', {}, token),

  createFolder: (name: string) =>
    request<FolderView>(
      '/api/folders',
      { method: 'POST', body: JSON.stringify({ name }) },
      token,
    ),

  updateFolder: (folderId: string, patch: Partial<FolderView>) =>
    request<FolderView>(
      `/api/folders/${folderId}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      token,
    ),

  /**
   * Drops the roll and its share links. Never refuses, and never loses a frame —
   * a folder holds pointers, so the photos stay in the library.
   */
  deleteFolder: (folderId: string) =>
    request<void>(`/api/folders/${folderId}`, { method: 'DELETE' }, token),

  listPhotos: (folderId: string) =>
    request<{ photos: PhotoView[] }>(`/api/folders/${folderId}/photos`, {}, token),

  /** Every photo, in no roll in particular. Backs the All photos view. */
  listLibrary: () => request<{ photos: PhotoView[] }>('/api/photos', {}, token),

  /**
   * Frames land in the library, in no roll. Filing them is `attachPhotos`.
   *
   * `noPreview` names the files that will be stored without one — a RAW with no
   * JPEG sibling in a format derive cannot extract a preview from. They upload
   * fine and download fine; they just never get a thumbnail.
   */
  requestUploads: (files: File[]) =>
    request<{
      uploads: Array<{ filename: string; url: string; photoId: string }>;
      noPreview: string[];
    }>(
      '/api/uploads',
      {
        method: 'POST',
        body: JSON.stringify({
          files: files.map((f) => ({
            filename: f.name,
            size: f.size,
            lastModified: f.lastModified,
          })),
        }),
      },
      token,
    ),

  /**
   * Destroys the photograph, in every roll at once. The only call here that can
   * lose an image — taking a frame out of one roll is `detachPhotos`.
   */
  destroyPhoto: (photoId: string) =>
    request<void>(`/api/photos/${photoId}`, { method: 'DELETE' }, token),

  /**
   * Membership, both directions. No batch cap and no S3 work behind either — the
   * photo never moves, only the pointers at it. `already` reports the no-ops so
   * the UI can say "3 were already in this roll" instead of claiming it added them.
   */
  attachPhotos: (folderId: string, photoIds: string[]) =>
    request<MembershipResult>(
      `/api/folders/${folderId}/photos`,
      { method: 'PUT', body: JSON.stringify({ photoIds }) },
      token,
    ),

  detachPhotos: (folderId: string, photoIds: string[]) =>
    request<MembershipResult>(
      `/api/folders/${folderId}/photos`,
      { method: 'DELETE', body: JSON.stringify({ photoIds }) },
      token,
    ),

  /**
   * How many of these frames each roll already holds, keyed by folder id. Rolls
   * holding none are absent. Feeds the "already there" note in the roll picker;
   * re-adding is a no-op either way.
   */
  photoMemberships: (photoIds: string[]) =>
    request<{ counts: Record<string, number> }>(
      '/api/photos/memberships',
      { method: 'POST', body: JSON.stringify({ photoIds }) },
      token,
    ),

  /**
   * Which rolls each photo is in, keyed by photo id. A frame in no roll is
   * absent rather than present with an empty list — that absence is exactly what
   * *Unfiled* filters on, so read it as `memberships[id] ?? []`.
   */
  listMemberships: () =>
    request<{ memberships: Record<string, string[]> }>('/api/memberships', {}, token),

  /**
   * Runs derive again for one frame. Returns as soon as S3 has the copy — the
   * derivatives land seconds later, so the caller polls rather than waits.
   */
  develop: (photoId: string) =>
    request<{ ok: true }>(`/api/photos/${photoId}/develop`, { method: 'POST' }, token),

  download: (photoId: string, kind: 'original' | 'raw') =>
    request<DownloadTarget>(
      `/api/photos/${photoId}/${kind}`,
      { method: 'POST' },
      token,
    ),

  /** The URL comes back exactly once — only the token's hash is persisted. */
  createShare: (
    folderId: string,
    /** `expiresInDays: 0` is a link with no expiry — only revoking ends it. */
    options: { expiresInDays: number; allowDownload: boolean; label?: string },
  ) =>
    request<{ url: string; expiresInDays: number }>(
      `/api/folders/${folderId}/shares`,
      { method: 'POST', body: JSON.stringify(options) },
      token,
    ),

  /** Includes expired shares: TTL deletion lags, and the query does not filter. */
  listShares: (folderId: string) =>
    request<{ shares: ShareSummary[] }>(`/api/folders/${folderId}/shares`, {}, token),

  /** `id` is the 12-hex prefix from `listShares`; the route resolves it by prefix. */
  revokeShare: (folderId: string, id: string) =>
    request<void>(`/api/folders/${folderId}/shares/${id}`, { method: 'DELETE' }, token),
});

/** The bound admin client, for the views that take one as a prop. */
export type AdminApi = ReturnType<typeof adminApi>;

// ----------------------------------------------------------------- public API

export const shareApi = {
  open: (shareToken: string) => request<ShareView>(`/api/share/${shareToken}`),

  /** JPEGs only — a share has no RAW route to call. */
  download: (shareToken: string, photoId: string) =>
    request<DownloadTarget>(`/api/share/${shareToken}/photos/${photoId}/original`, {
      method: 'POST',
    }),
};

export interface MembershipResult {
  changed: string[];
  /** Already in the roll (or already out of it) — a no-op, not a failure. */
  already: string[];
  failed: Array<{ photoId: string; message: string }>;
}

export interface DownloadTarget {
  url: string;
  filename: string;
}

/**
 * Saves a signed object URL under its original filename.
 *
 * The URL is signed bare — no `response-content-disposition`, because that
 * parameter is part of the signed resource and CloudFront strips it before S3
 * anyway (see `signObjectUrl`). `download` supplies the name instead, which the
 * browser honors only because the objects are served from this same origin.
 */
export function saveAs({ url, filename }: DownloadTarget) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Uploads one file to its presigned URL, reporting 0..1 progress. */
export function uploadFile(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // XHR rather than fetch: fetch still has no upload progress events, and a
    // 30MB RAF with no feedback looks like a hang.
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed for ${file.name} (${xhr.status})`)),
    );
    xhr.addEventListener('error', () =>
      reject(new Error(`Upload failed for ${file.name}`)),
    );
    xhr.send(file);
  });
}
