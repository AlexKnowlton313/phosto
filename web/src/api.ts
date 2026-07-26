export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  domain: string;
}

export interface PhotoView {
  photoId: string;
  basename: string;
  takenAt: string;
  width?: number;
  height?: number;
  ready: boolean;
  hasRaw: boolean;
  canDownload: boolean;
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: string;
  shutter?: string;
  focalLength?: string;
  urls: { thumb: string; large: string };
}

export interface FolderView {
  folderId: string;
  name: string;
  createdAt: string;
  photoCount: number;
  rawVisibleDefault: boolean;
  /** Derivative key is `f/<folderId>/<coverPhotoId>/thumb.webp` — no API field needed. */
  coverPhotoId?: string;
}

export interface ShareView {
  folder: { name: string; photoCount: number };
  permissions: { allowDownload: boolean; allowRaw: boolean };
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // Signed cookies are set by the API and read by CloudFront on image requests.
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (payload as { error?: string }).error ?? res.statusText);
  }
  return payload as T;
}

// ------------------------------------------------------------------ admin API

export const adminApi = (token: string) => ({
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

  listPhotos: (folderId: string) =>
    request<{ photos: PhotoView[] }>(`/api/folders/${folderId}/photos`, {}, token),

  requestUploads: (folderId: string, files: File[]) =>
    request<{ uploads: Array<{ filename: string; url: string; photoId: string }> }>(
      `/api/folders/${folderId}/uploads`,
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

  deletePhoto: (folderId: string, photoId: string) =>
    request<void>(
      `/api/folders/${folderId}/photos/${photoId}`,
      { method: 'DELETE' },
      token,
    ),

  download: (folderId: string, photoId: string, kind: 'original' | 'raw') =>
    request<DownloadTarget>(
      `/api/folders/${folderId}/photos/${photoId}/${kind}`,
      { method: 'POST' },
      token,
    ),

  createShare: (
    folderId: string,
    options: { expiresInDays: number; allowDownload: boolean; allowRaw: boolean },
  ) =>
    request<{ url: string; expiresInDays: number }>(
      `/api/folders/${folderId}/shares`,
      { method: 'POST', body: JSON.stringify(options) },
      token,
    ),
});

// ----------------------------------------------------------------- public API

export const shareApi = {
  open: (shareToken: string) => request<ShareView>(`/api/share/${shareToken}`),

  download: (shareToken: string, photoId: string, kind: 'original' | 'raw') =>
    request<DownloadTarget>(`/api/share/${shareToken}/photos/${photoId}/${kind}`, {
      method: 'POST',
    }),
};

export interface DownloadTarget {
  url: string;
  filename: string;
  expiresIn: number;
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
