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
import { ContactSheet, EdgeHeader } from '../components/ContactSheet';
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
  const [current, setCurrent] = useState<FolderView>();
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [showNegatives, setShowNegatives] = useState(false);
  const [openIndex, setOpenIndex] = useState<number>();
  const [upload, setUpload] = useState<UploadState>();
  const [shareUrl, setShareUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  // The signed cookies, not the JWT, are what let the browser load images.
  useEffect(() => {
    api.startSession().catch(() => setError('Could not start an image session'));
    api
      .listFolders()
      .then((r) => setFolders(r.folders))
      .catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const openFolder = useCallback(
    async (folder: FolderView) => {
      setCurrent(folder);
      setShareUrl(undefined);
      setShowNegatives(folder.rawVisibleDefault);
      const { photos } = await api.listPhotos(folder.folderId);
      setPhotos(photos);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  const refresh = useCallback(async () => {
    if (!current) return;
    const { photos } = await api.listPhotos(current.folderId);
    setPhotos(photos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, token]);

  // Derivatives land a few seconds after upload, so poll while any are pending.
  useEffect(() => {
    if (!current || photos.every((p) => p.ready)) return;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [current, photos, refresh]);

  const newFolder = async () => {
    const name = window.prompt('Name this roll');
    if (!name?.trim()) return;
    const folder = await api.createFolder(name.trim());
    setFolders((prev) => [folder, ...(prev ?? [])]);
    openFolder(folder);
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
    const allowRaw = window.confirm(
      'Include RAW files in this share?\n\nOK includes them behind the negatives toggle. Cancel shares JPEGs only.',
    );
    const { url } = await api.createShare(current.folderId, {
      expiresInDays: 30,
      allowDownload: true,
      allowRaw,
    });
    setShareUrl(url);
  };

  const download = async (photo: PhotoView, kind: 'original' | 'raw') => {
    if (!current) return;
    saveAs(await api.download(current.folderId, photo.photoId, kind));
  };

  const removePhoto = async (photo: PhotoView) => {
    if (!current) return;
    if (!window.confirm(`Delete ${photo.basename}? This removes the RAW too.`)) return;
    await api.deletePhoto(current.folderId, photo.photoId);
    setOpenIndex(undefined);
    await refresh();
  };

  // ------------------------------------------------------------------ folders

  if (!current) {
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
                className="roll"
                onClick={() => openFolder(folder)}
              >
                <div className="roll-name">{folder.name}</div>
                <div className="roll-meta">
                  {folder.photoCount} {folder.photoCount === 1 ? 'frame' : 'frames'}
                </div>
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  // ------------------------------------------------------------- folder detail

  const rawCount = photos.filter((p) => p.hasRaw).length;

  return (
    <>
      <EdgeHeader name={current.name} photos={photos} />

      <div className="toolbar">
        <button className="btn" onClick={() => setCurrent(undefined)}>
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

        {rawCount > 0 && (
          <button
            className="btn btn-negatives"
            aria-pressed={showNegatives}
            onClick={() => setShowNegatives((on) => !on)}
          >
            {showNegatives ? 'Hide negatives' : `Show negatives (${rawCount})`}
          </button>
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

      {photos.length === 0 ? (
        <div className="empty">
          <h2>Empty roll</h2>
          <p className="note">
            Add JPEGs and RAFs together — matching filenames become one frame.
          </p>
        </div>
      ) : (
        <ContactSheet photos={photos} showNegatives={showNegatives} onOpen={setOpenIndex} />
      )}

      {openIndex !== undefined && (
        <Lightbox
          photos={photos}
          index={openIndex}
          showNegatives={showNegatives}
          onClose={() => setOpenIndex(undefined)}
          onNavigate={setOpenIndex}
          onDownload={download}
          onDelete={removePhoto}
        />
      )}
    </>
  );
}
