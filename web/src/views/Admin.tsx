import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adminApi,
  saveAs,
  uploadFile,
  type AppConfig,
  type FolderView,
  type PhotoView,
} from '../api';
import { signOut } from '../auth';
import {
  ContactSheet,
  EdgeHeader,
  selectable,
  useSelection,
} from '../components/ContactSheet';
import { Lightbox } from '../components/Lightbox';

/** Enough to saturate a connection without starving the UI thread. */
const UPLOAD_CONCURRENCY = 4;

interface UploadState {
  total: number;
  done: number;
  fraction: number;
}

export function Admin({ config, token }: { config: AppConfig; token: string }) {
  const api = adminApi(token);
  const [folders, setFolders] = useState<FolderView[]>();
  // The open folder lives in location.hash, not in state, so the browser's
  // back button and a reload both land where the user expects. `#<folderId>`
  // rather than a path because /f/* is a CloudFront behaviour, not the SPA.
  const [folderId, setFolderId] = useState(() => location.hash.slice(1));
  // undefined until the first listPhotos lands — an empty array is a real
  // answer ("empty roll"), and the two must not render the same.
  const [photos, setPhotos] = useState<PhotoView[]>();
  const [openIndex, setOpenIndex] = useState<number>();
  const [upload, setUpload] = useState<UploadState>();
  const [shareUrl, setShareUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const { selected, toggle, clear, retain } = useSelection();
  // A batch runs for seconds with no feedback of its own, which makes a second
  // click likely — and two concurrent loops are exactly the burst the 150ms gap
  // between downloads exists to avoid.
  const [batching, setBatching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The signed cookies, not the JWT, are what let the browser load images.
  // Sequential on purpose: cover thumbnails render as soon as the folders land,
  // so the cookie has to exist first or they 403 on a cold load.
  useEffect(() => {
    api
      .startSession()
      .catch(() => setError('Could not start an image session'))
      .then(() => api.listFolders())
      .then((r) => setFolders(r.folders))
      .catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    const sync = () => setFolderId(location.hash.slice(1));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const current = folders?.find((f) => f.folderId === folderId);

  const refresh = useCallback(async () => {
    if (!folderId) return;
    const { photos } = await api.listPhotos(folderId);
    setPhotos(photos);
    // Here rather than in removePhoto: any refresh can drop a photo, and a
    // selection holding a deleted id keeps the sheet in selection mode with
    // nothing visibly marked and no obvious way out.
    retain(photos.map((p) => p.photoId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, token]);

  useEffect(() => {
    setPhotos(undefined);
    setShareUrl(undefined);
    setOpenIndex(undefined);
    clear();
    refresh().catch((err: Error) => setError(err.message));
  }, [refresh, clear]);

  // Derivatives land a few seconds after upload, so poll while any are pending.
  useEffect(() => {
    if (!folderId || !photos || photos.every((p) => p.ready)) return;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [folderId, photos, refresh]);

  const newFolder = async () => {
    const name = window.prompt('Name this roll');
    if (!name?.trim()) return;
    const folder = await api.createFolder(name.trim());
    setFolders((prev) => [folder, ...(prev ?? [])]);
    location.hash = folder.folderId;
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length || !current) return;
    const list = [...files];
    setError(undefined);

    try {
      const { uploads } = await api.requestUploads(current.folderId, list);
      const byName = new Map(list.map((f) => [f.name, f]));
      const progress = new Array<number>(uploads.length).fill(0);

      setUpload({ total: uploads.length, done: 0, fraction: 0 });

      let done = 0;
      let cursor = 0;

      const report = () =>
        setUpload({
          total: uploads.length,
          done,
          fraction: progress.reduce((a, b) => a + b, 0) / uploads.length,
        });

      const worker = async () => {
        while (cursor < uploads.length) {
          const slot = cursor++;
          const item = uploads[slot];
          const file = byName.get(item.filename);
          if (!file) continue;

          await uploadFile(item.url, file, (fraction) => {
            progress[slot] = fraction;
            report();
          });

          progress[slot] = 1;
          done += 1;
          report();
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, uploads.length) }, worker),
      );

      setUpload(undefined);
      await refresh();
    } catch (err) {
      setUpload(undefined);
      setError((err as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const share = async () => {
    if (!current) return;
    const { url } = await api.createShare(current.folderId, {
      expiresInDays: 30,
      allowDownload: true,
    });
    setShareUrl(url);
  };

  const download = async (photo: PhotoView, kind: 'original' | 'raw') => {
    if (!current) return;
    saveAs(await api.download(current.folderId, photo.photoId, kind));
  };

  const downloadSelected = async (kind: 'original' | 'raw') => {
    if (!current || !photos) return;
    setError(undefined);
    setBatching(true);

    try {
      for (const photo of selectable(photos, selected, kind)) {
        // Signed one at a time, immediately before its download: DOWNLOAD_TTL is
        // five minutes and a long batch would outlive URLs minted up front.
        saveAs(await api.download(current.folderId, photo.photoId, kind));
        // Browsers silently drop a burst of programmatic downloads.
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (err) {
      // Stop on the first failure rather than marching through the rest: these
      // fail as a group — an expired session refuses frame 2 through 40 too.
      setError(`Download stopped: ${(err as Error).message}`);
    } finally {
      setBatching(false);
    }
  };

  const setCover = async (photo: PhotoView) => {
    if (!current) return;
    const folder = await api.updateFolder(current.folderId, {
      coverPhotoId: photo.photoId,
    });
    setFolders((prev) => prev?.map((f) => (f.folderId === folder.folderId ? folder : f)));
    setOpenIndex(undefined);
  };

  const removePhoto = async (photo: PhotoView) => {
    if (!current) return;
    if (!window.confirm(`Delete ${photo.basename}? This removes the RAW too.`)) return;
    await api.deletePhoto(current.folderId, photo.photoId);
    setOpenIndex(undefined);
    await refresh();
  };

  // ------------------------------------------------------------------ folders

  // A reload with a hash arrives before the folder list does; don't flash the
  // roll index on the way to the folder the user actually asked for.
  if (!current) {
    if (folderId && !folders) {
      return (
        <div className="empty">
          <p className="note">Loading…</p>
        </div>
      );
    }

    return (
      <>
        <header className="edge">
          <h1 className="edge-name">Rolls</h1>
          <div className="edge-data">
            <span>{folders?.length ?? 0} folders</span>
          </div>
        </header>

        <div className="toolbar">
          <button className="btn" onClick={newFolder}>
            New roll
          </button>
          <div className="spacer" />
          <button
            className="btn"
            onClick={async () => {
              // Clear the CloudFront cookies too, or images stay reachable for the
              // rest of the session TTL after signing out. A failure here must not
              // block the local sign-out.
              await api.endSession().catch(() => {});
              signOut(config);
              location.reload();
            }}
          >
            Sign out
          </button>
        </div>

        {error && <p className="error" style={{ padding: '16px 24px' }}>{error}</p>}

        {folders?.length === 0 ? (
          <div className="empty">
            <h2>No rolls yet</h2>
            <p className="note">Create one, then drop your JPEGs and RAFs into it.</p>
          </div>
        ) : (
          <div className="rolls">
            {folders?.map((folder) => (
              <button
                key={folder.folderId}
                className={folder.coverPhotoId ? 'roll roll-cover' : 'roll'}
                onClick={() => (location.hash = folder.folderId)}
              >
                {folder.coverPhotoId && (
                  // alt="" so a deleted or moved cover collapses to the plain
                  // tile rather than a broken-image icon. No JS fallback needed.
                  <img
                    src={`/f/${folder.folderId}/${folder.coverPhotoId}/thumb.webp`}
                    alt=""
                  />
                )}
                <div className="roll-text">
                  <div className="roll-name">{folder.name}</div>
                  <div className="roll-meta">
                    {folder.photoCount} {folder.photoCount === 1 ? 'frame' : 'frames'}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  // ------------------------------------------------------------- folder detail

  return (
    <>
      <EdgeHeader name={current.name} photos={photos ?? []} />

      <div className="toolbar">
        <button className="btn" onClick={() => (location.hash = '')}>
          ← All rolls
        </button>

        <button className="btn" onClick={() => fileInput.current?.click()}>
          Add photos
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.heic,.heif,.hif,.raf,.dng,.cr2,.cr3,.nef,.arw,.orf,.rw2"
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />

        {selected.size > 0 && (
          <>
            <span className="note">{selected.size} selected</span>
            {selectable(photos ?? [], selected, 'original').length > 0 && (
              <button
                className="btn"
                disabled={batching}
                onClick={() => downloadSelected('original')}
              >
                Download JPEGs
              </button>
            )}
            {selectable(photos ?? [], selected, 'raw').length > 0 && (
              <button
                className="btn btn-negatives"
                disabled={batching}
                onClick={() => downloadSelected('raw')}
              >
                Download RAWs
              </button>
            )}
            <button className="btn" onClick={clear}>
              Clear
            </button>
          </>
        )}

        <div className="spacer" />

        <button className="btn" onClick={share}>
          Share roll
        </button>
      </div>

      {upload && (
        <>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${upload.fraction * 100}%` }} />
          </div>
          <p className="note" style={{ padding: '8px 24px' }}>
            Uploading {upload.done} of {upload.total}…
          </p>
        </>
      )}

      {shareUrl && (
        <div style={{ padding: '16px 24px' }} className="stack">
          <label htmlFor="share-url">Share link — expires in 30 days</label>
          <div className="share-link" id="share-url">
            {shareUrl}
          </div>
          <div>
            <button
              className="btn"
              onClick={() => navigator.clipboard.writeText(shareUrl)}
            >
              Copy link
            </button>
          </div>
        </div>
      )}

      {error && <p className="error" style={{ padding: '16px 24px' }}>{error}</p>}

      {!photos ? (
        <div className="empty">
          <p className="note">Loading…</p>
        </div>
      ) : photos.length === 0 ? (
        <div className="empty">
          <h2>Empty roll</h2>
          <p className="note">
            Add JPEGs and RAFs together — matching filenames become one frame.
          </p>
        </div>
      ) : (
        <ContactSheet
          photos={photos}
          selected={selected}
          onOpen={setOpenIndex}
          onToggle={toggle}
        />
      )}

      {openIndex !== undefined && photos && (
        <Lightbox
          photos={photos}
          index={openIndex}
          onClose={() => setOpenIndex(undefined)}
          onNavigate={setOpenIndex}
          onDownload={download}
          onDelete={removePhoto}
          onSetCover={setCover}
        />
      )}
    </>
  );
}
