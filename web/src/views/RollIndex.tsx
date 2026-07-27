import { useRef, useState } from 'react';
import {
  LIBRARY_ID,
  uploadFile,
  type AdminApi,
  type AppConfig,
  type FolderView,
} from '../api';
import { signOut } from '../auth';
import { useDialog } from '../components/Dialog';

/** Enough to saturate a connection without starving the UI thread. */
const UPLOAD_CONCURRENCY = 4;

interface UploadState {
  total: number;
  done: number;
  fraction: number;
}

interface Props {
  api: AdminApi;
  config: AppConfig;
  folders?: FolderView[];
  onFolderCreated: (folder: FolderView) => void;
  /** Whatever went wrong loading the folder list — this view has the screen. */
  loadError?: string;
}

/**
 * The roll index, and the only place a photograph enters the library: *Add
 * photos* is here rather than inside a roll because a frame arrives belonging to
 * nobody, so there is never a "which roll did this go to".
 */
export function RollIndex({ api, config, folders, onFolderCreated, loadError }: Props) {
  const [upload, setUpload] = useState<UploadState>();
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const { prompt, dialog } = useDialog();

  const newFolder = async () => {
    const name = await prompt({ title: 'Name this roll', confirmLabel: 'Create' });
    if (!name) return;
    onFolderCreated(await api.createFolder(name));
  };

  // Uploads land in the library, in no roll — which is what a photo belonging to
  // nobody means. Filing is a second step, from All photos with "Add to roll…".
  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files];
    setError(undefined);

    try {
      const { uploads } = await api.requestUploads(list);
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
      // Land on the sheet the frames actually went to; the hash change loads it.
      location.hash = LIBRARY_ID;
    } catch (err) {
      setUpload(undefined);
      setError((err as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const shown = error ?? loadError;

  return (
    <>
      <header className="edge">
        <h1 className="edge-name">Rolls</h1>
        <div className="edge-data">
          <span>{folders?.length ?? 0} folders</span>
        </div>
      </header>

      <div className="toolbar">
        <button
          type="button"
          className="btn"
          disabled={Boolean(upload)}
          onClick={newFolder}
        >
          New roll
        </button>
        {/* The only upload in the app. Frames go to the library, not to a
            roll — nothing here has to answer "which one". */}
        <button
          type="button"
          className="btn"
          disabled={Boolean(upload)}
          onClick={() => fileInput.current?.click()}
        >
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
        <div className="spacer" />
        <button
          type="button"
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

      {shown && <p className="error" style={{ padding: '16px 24px' }}>{shown}</p>}

      {/* No empty state: uploads land in the library before any roll exists, so
          zero rolls is ordinary, and hiding the list would hide the one tile
          that reaches the frames. */}
      <div className="rolls">
        {/* First, and always present even with no rolls at all: it is the
            library itself, and the only place a photograph in no roll can
            be reached from. */}
        <button
          type="button"
          className="roll"
          onClick={() => (location.hash = LIBRARY_ID)}
        >
          <div className="roll-text">
            <div className="roll-name">All photos</div>
            <div className="roll-meta">every frame, in no roll in particular</div>
          </div>
        </button>

        {folders?.map((folder) => (
          <button
            type="button"
            key={folder.folderId}
            className={folder.coverPhotoId ? 'roll roll-cover' : 'roll'}
            onClick={() => (location.hash = folder.folderId)}
          >
            {folder.coverPhotoId && (
              // alt="" so a deleted cover collapses to the plain tile rather
              // than a broken-image icon. No JS fallback needed.
              <img src={`/f/${folder.coverPhotoId}/thumb.webp`} alt="" />
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

      {dialog}
    </>
  );
}
