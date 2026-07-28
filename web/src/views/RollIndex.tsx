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

/** `createUploads`' own cap. The client slices to it rather than hit the 400. */
const BATCH = 200;

/** Sentinel choice in the file-on-the-spot picker; no folder id can be `new`. */
const NEW_ROLL = 'new';

/** Filename without its extension — what pairs XT300024.JPG with .RAF. */
const stemOf = (filename: string) => filename.replace(/\.[^.]+$/, '');

/**
 * Slices a card dump into batches the upload route will accept.
 *
 * Grouped by basename first and packed whole: a pair split across two calls
 * becomes two photographs with different ids instead of one frame with
 * `hasRaw`, and nothing afterwards can put them back together.
 */
function batchFiles(files: File[]): File[][] {
  const groups = new Map<string, File[]>();
  for (const file of files) {
    const stem = stemOf(file.name);
    groups.set(stem, [...(groups.get(stem) ?? []), file]);
  }

  const batches: File[][] = [[]];
  for (const group of groups.values()) {
    if (batches[batches.length - 1].length + group.length > BATCH) batches.push([]);
    batches[batches.length - 1].push(...group);
  }
  return batches;
}

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
  const { confirm, choose, prompt, dialog } = useDialog();

  const newFolder = async () => {
    const name = await prompt({ title: 'Name this roll', confirmLabel: 'Create' });
    if (!name) return;
    onFolderCreated(await api.createFolder(name));
  };

  /**
   * "You have uploaded these names before." A basename match is a hint, not a
   * fact — two cards really can both hold DSCF0001 — so this warns and lets the
   * upload through. The realistic mistake it catches is the same card mounted
   * twice, which is 8.6 GB of duplicate bytes nobody wants.
   *
   * ponytail: one `listLibrary` per upload gesture rather than plumbing the
   * library through Admin into a view that otherwise has no use for it. Same
   * query All photos runs, ~27 RRU. Lift it up if the index ever needs the
   * photos for something else.
   */
  const confirmDuplicates = async (list: File[]) => {
    const known = new Set(
      await api
        .listLibrary()
        .then((r) => r.photos.map((p) => p.basename))
        .catch(() => []),
    );
    const clash = [...new Set(list.map((f) => stemOf(f.name)))].filter((s) =>
      known.has(s),
    );
    if (clash.length === 0) return true;

    return confirm({
      title: `${clash.length} of these names are already in the library`,
      body:
        `${clash.slice(0, 3).join(', ')}${clash.length > 3 ? '…' : ''} — uploading ` +
        'again stores a second copy of the bytes as separate frames. Only the ' +
        'filenames are compared, so two cards can clash without being the same shot.',
      confirmLabel: 'Upload anyway',
    });
  };

  /**
   * The ids are in hand the moment the uploads are issued, so filing is one
   * dialog rather than a trip through All photos. Cancel is a first-class
   * answer: the frames are in the library either way.
   */
  const fileFrames = async (photoIds: string[]): Promise<boolean> => {
    const choice = await choose({
      title: `${photoIds.length} frame(s) uploaded. Add them to a roll?`,
      body: 'They are in the library either way — Cancel leaves them unfiled.',
      options: [
        { id: NEW_ROLL, name: 'New roll…' },
        ...(folders ?? []).map((f) => ({
          id: f.folderId,
          name: f.name,
          note: `${f.photoCount} frames`,
        })),
      ],
    });
    if (!choice) return false;

    let target = folders?.find((f) => f.folderId === choice);
    if (choice === NEW_ROLL) {
      const name = await prompt({ title: 'Name this roll', confirmLabel: 'Create' });
      if (!name) return false;
      target = await api.createFolder(name);
    }
    if (!target) return false;

    await api.attachPhotos(target.folderId, photoIds);

    // A roll made here has to reach the shell's list before the hash points at
    // it, or Admin cannot resolve the id and bounces back to this index.
    // `onFolderCreated` does both; an existing roll only needs the hash.
    if (choice === NEW_ROLL) onFolderCreated(target);
    else location.hash = target.folderId;
    return true;
  };

  // Uploads land in the library, in no roll — which is what a photo belonging to
  // nobody means. Filing is a second step, from All photos with "Add to roll…".
  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files];
    setError(undefined);

    try {
      if (!(await confirmDuplicates(list))) return;

      // One call per 200 files, in parallel: the batches share no record and no
      // roll counter, so nothing contends. A 512-frame card is three Lambda
      // invocations instead of a 400 that refused the whole selection.
      const batches = await Promise.all(batchFiles(list).map((b) => api.requestUploads(b)));
      const uploads = batches.flatMap((b) => b.uploads);
      const noPreview = batches.flatMap((b) => b.noPreview);
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

      // Said here rather than left to be discovered as frames stuck at
      // DEVELOPING: these are stored and downloadable, they just have no
      // preview and never will. After the upload, not before — the records and
      // presigned URLs already exist by the time the API can answer, so a
      // cancel at this point would strand them.
      if (noPreview.length > 0) {
        await confirm({
          title: `${noPreview.length} file(s) stored without a preview`,
          body:
            `${noPreview.slice(0, 3).join(', ')}${noPreview.length > 3 ? '…' : ''} ` +
            'are RAW formats with no embedded-preview extractor. They stay in the ' +
            'library and download fine, but will show no thumbnail.',
          confirmLabel: 'OK',
        });
      }

      // File them now, while the ids are still in hand. Declining lands on All
      // photos as before; the hash change loads whichever sheet they went to.
      const ids = [...new Set(uploads.map((u) => u.photoId))];
      if (!(await fileFrames(ids))) location.hash = LIBRARY_ID;
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
