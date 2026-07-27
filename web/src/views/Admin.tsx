import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adminApi,
  LIBRARY_ID,
  saveAs,
  uploadFile,
  type AppConfig,
  type FolderView,
  type MembershipResult,
  type PhotoView,
  type ShareSummary,
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

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * `expiresAt` is unix seconds. One source of truth for both the word and the
 * greying: computing them separately let a link with 20 minutes left round down
 * to "expired" while still rendering live and still working.
 */
function expiry(expiresAt: number) {
  const ms = expiresAt * 1000 - Date.now();
  if (ms <= 0) return { expired: true, label: 'expired' };

  // Ceil, not round: anything still live has to read as live, even at a minute.
  const hours = Math.ceil(ms / 3600_000);
  return {
    expired: false,
    label:
      hours < 48
        ? relative.format(hours, 'hour')
        : relative.format(Math.round(hours / 24), 'day'),
  };
}

const dayMonthYear = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

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
  // The created link, kept only until the folder changes: the API returns it once
  // and stores nothing but its hash, so leaving this view loses it for good.
  const [created, setCreated] = useState<{ url: string; expiresInDays: number }>();
  const [shares, setShares] = useState<ShareSummary[]>();
  const [shareForm, setShareForm] = useState<{
    label: string;
    days: number;
    allowDownload: boolean;
  }>();
  const [error, setError] = useState<string>();
  // What a batch actually did — "Added 12 frame(s) to Iceland (3 already there)",
  // or a running count while a long delete works through the selection. Cleared on
  // every folder change below: it describes a roll the user may have left.
  const [status, setStatus] = useState<string>();
  const { selected, toggle, clear, retain } = useSelection();
  // A batch runs for seconds with no feedback of its own, which makes a second
  // click likely — and two concurrent loops are exactly the burst the 150ms gap
  // between downloads exists to avoid.
  const [batching, setBatching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // "All photos" is a pseudo-roll: it has no folder record, so it can't be
  // renamed, shared or deleted, and there is nothing to detach from. Everything
  // else about it is an ordinary contact sheet.
  const isLibrary = folderId === LIBRARY_ID;

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

  const realFolder = folders?.find((f) => f.folderId === folderId);
  // Synthesised so the whole detail view below can read `current.name` without
  // branching on every line. `photoCount` is filled from the loaded sheet.
  const current: FolderView | undefined = isLibrary
    ? {
        folderId: LIBRARY_ID,
        name: 'All photos',
        createdAt: '',
        photoCount: photos?.length ?? 0,
      }
    : realFolder;

  const refresh = useCallback(async () => {
    if (!folderId) return;
    const { photos } = await (folderId === LIBRARY_ID
      ? api.listLibrary()
      : api.listPhotos(folderId));
    setPhotos(photos);
    // Here rather than in removePhoto: any refresh can drop a photo, and a
    // selection holding a deleted id keeps the sheet in selection mode with
    // nothing visibly marked and no obvious way out.
    retain(photos.map((p) => p.photoId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, token]);

  const loadShares = useCallback(async () => {
    // The library is not a folder, so it has no share links to list.
    if (!folderId || folderId === LIBRARY_ID) return;
    setShares((await api.listShares(folderId)).shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, token]);

  useEffect(() => {
    setPhotos(undefined);
    setCreated(undefined);
    setShares(undefined);
    setShareForm(undefined);
    setOpenIndex(undefined);
    setStatus(undefined);
    clear();
    refresh().catch((err: Error) => setError(err.message));
    // Separate from `refresh` on purpose — that one is re-run every 4s while
    // derivatives are pending, and the share list has nothing to do with them.
    loadShares().catch((err: Error) => setError(err.message));
  }, [refresh, loadShares, clear]);

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

  // Uploads happen from the roll index and land in the library, in no roll —
  // which is what a photo belonging to nobody means. Filing is a second step,
  // from All photos with "Add to roll…".
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

  const share = async () => {
    if (!current || !shareForm) return;
    setError(undefined);
    try {
      setCreated(
        await api.createShare(current.folderId, {
          expiresInDays: shareForm.days,
          allowDownload: shareForm.allowDownload,
          label: shareForm.label.trim() || undefined,
        }),
      );
      setShareForm(undefined);
      await loadShares();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revokeShare = async (link: ShareSummary) => {
    if (!current) return;
    if (
      !window.confirm(
        `Revoke ${link.label ? `“${link.label}”` : 'this link'}? It stops working ` +
          'immediately, but a viewer with the roll already open keeps their signed ' +
          'cookie until it expires.',
      )
    ) {
      return;
    }
    setError(undefined);
    try {
      await api.revokeShare(current.folderId, link.id);
      setCreated(undefined);
      await loadShares();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const download = async (photo: PhotoView, kind: 'original' | 'raw') => {
    saveAs(await api.download(photo.photoId, kind));
  };

  const downloadSelected = async (kind: 'original' | 'raw') => {
    if (!current || !photos) return;
    setError(undefined);
    setBatching(true);

    try {
      for (const photo of selectable(photos, selected, kind)) {
        // Signed one at a time, immediately before its download: DOWNLOAD_TTL is
        // five minutes and a long batch would outlive URLs minted up front.
        saveAs(await api.download(photo.photoId, kind));
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

  /**
   * Reports what a membership change actually did.
   *
   * `failed` frames are named rather than counted: the selection is cleared
   * either way, so a bare number would leave the owner unable to tell which ones
   * to try again. `already` is not an error — it is how re-adding an overlapping
   * selection behaves — but saying so beats silently reporting fewer than were
   * selected.
   */
  const membershipNote = (
    { changed, already, failed }: MembershipResult,
    verb: string,
    rollName: string,
  ) => {
    if (failed.length > 0) {
      const names = failed.map(
        (f) => photos?.find((p) => p.photoId === f.photoId)?.basename ?? f.photoId,
      );
      return `${verb} ${changed.length}, but ${failed.length} failed: ${names.join(', ')}`;
    }
    const skipped = already.length > 0 ? ` (${already.length} already there)` : '';
    return `${verb} ${changed.length} frame(s) ${verb === 'Removed' ? 'from' : 'to'} ${rollName}${skipped}`;
  };

  /**
   * Puts the selection into another roll. A frame can be in as many rolls as you
   * like, so this adds rather than moves — it leaves the current roll untouched,
   * and there is no destination it could fail to reach.
   */
  const addToRoll = async () => {
    if (!folders?.length) return;
    // A numbered prompt rather than a dialog: one user, no modal infrastructure,
    // and every other choice in this app is already made this way.
    const others = folders.filter((f) => f.folderId !== current?.folderId);
    const answer = window.prompt(
      `Add ${selected.size} frame(s) to which roll?\n\n` +
        others.map((f, i) => `${i + 1}. ${f.name}`).join('\n'),
    );
    const target = others[Number(answer) - 1];
    if (!target) return;

    setError(undefined);
    setBatching(true);
    try {
      const result = await api.attachPhotos(target.folderId, [...selected]);
      setStatus(membershipNote(result, 'Added', target.name));
      clear();
      setFolders((await api.listFolders()).folders);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBatching(false);
    }
  };

  /** Takes the selection out of this roll. The photographs are untouched. */
  const removeFromRoll = async () => {
    if (!current || isLibrary) return;

    setError(undefined);
    setBatching(true);
    try {
      const result = await api.detachPhotos(current.folderId, [...selected]);
      setStatus(membershipNote(result, 'Removed', current.name));
      clear();
      setOpenIndex(undefined);
      await refresh();
      // The count changed, and removing the cover frame cleared it.
      setFolders((await api.listFolders()).folders);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBatching(false);
    }
  };

  /**
   * Destroys the photographs themselves — the only irreversible action in the
   * app, which is why it is offered from All photos only and still confirms.
   */
  const destroySelected = async () => {
    const ids = [...selected];
    if (
      !window.confirm(
        `Permanently delete ${ids.length} photograph(s)?\n\n` +
          'This removes the originals and RAWs from every roll they are in. ' +
          'To take them out of one roll, open that roll and use Remove from roll.',
      )
    ) {
      return;
    }

    setError(undefined);
    setBatching(true);
    let done = 0;
    try {
      for (const photoId of ids) {
        await api.destroyPhoto(photoId);
        done += 1;
        setStatus(`Deleted ${done} of ${ids.length}…`);
      }
    } catch (err) {
      setError(`${(err as Error).message} (${ids.length - done} not deleted)`);
    } finally {
      setStatus(undefined);
      clear();
      setOpenIndex(undefined);
      setBatching(false);
      await refresh();
      setFolders((await api.listFolders()).folders);
    }
  };

  const renameRoll = async () => {
    if (!current) return;
    const name = window.prompt('Rename this roll', current.name);
    // Whitespace-only cancels rather than clearing the name. The API refuses it
    // too, so this only saves the round trip.
    if (!name?.trim()) return;
    const folder = await api.updateFolder(current.folderId, { name: name.trim() });
    setFolders((prev) => prev?.map((f) => (f.folderId === folder.folderId ? folder : f)));
  };

  /**
   * Drops the roll. No frame is at risk: a roll holds pointers, so the
   * photographs stay in the library and in any other roll they are in.
   */
  const deleteRoll = async () => {
    if (!current || isLibrary || !photos) return;

    if (
      !window.confirm(
        `Delete the roll "${current.name}" and its share links?\n\n` +
          `The ${photos.length} frame(s) in it stay in All photos.`,
      )
    ) {
      return;
    }

    setError(undefined);
    setBatching(true);
    try {
      await api.deleteFolder(current.folderId);
      setFolders((await api.listFolders()).folders);
      location.hash = '';
    } catch (err) {
      setError((err as Error).message);
      await refresh();
    } finally {
      setBatching(false);
    }
  };

  const setCover = async (photo: PhotoView) => {
    if (!current || isLibrary) return;
    const folder = await api.updateFolder(current.folderId, {
      coverPhotoId: photo.photoId,
    });
    setFolders((prev) => prev?.map((f) => (f.folderId === folder.folderId ? folder : f)));
    setOpenIndex(undefined);
  };

  const removePhoto = async (photo: PhotoView) => {
    if (
      !window.confirm(
        `Permanently delete ${photo.basename}?\n\n` +
          'This removes the original and RAW from every roll it is in.',
      )
    ) {
      return;
    }
    await api.destroyPhoto(photo.photoId);
    setOpenIndex(undefined);
    await refresh();
    setFolders((await api.listFolders()).folders);
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
          <button className="btn" disabled={Boolean(upload)} onClick={newFolder}>
            New roll
          </button>
          {/* The only upload in the app. Frames go to the library, not to a
              roll — nothing here has to answer "which one". */}
          <button
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

        {error && <p className="error" style={{ padding: '16px 24px' }}>{error}</p>}

        {/* No empty state: uploads land in the library before any roll exists, so
            zero rolls is ordinary, and hiding the list would hide the one tile
            that reaches the frames. */}
        <div className="rolls">
          {/* First, and always present even with no rolls at all: it is the
              library itself, and the only place a photograph in no roll can
              be reached from. */}
          <button className="roll" onClick={() => (location.hash = LIBRARY_ID)}>
            <div className="roll-text">
              <div className="roll-name">All photos</div>
              <div className="roll-meta">every frame, in no roll in particular</div>
            </div>
          </button>

          {folders?.map((folder) => (
            <button
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
      </>
    );
  }

  // ------------------------------------------------------------- folder detail

  const shown = photos;

  return (
    <>
      {/* The library is not a folder: nothing to rename. */}
      <EdgeHeader
        name={current.name}
        photos={shown ?? []}
        onRename={isLibrary ? undefined : renameRoll}
      />

      <div className="toolbar">
        <button className="btn" disabled={batching} onClick={() => (location.hash = '')}>
          ← All rolls
        </button>


        <div className="spacer" />

        {!isLibrary && (
        <button
          className="btn"
          disabled={batching}
          onClick={() => {
            // Drop the previous link when opening the form again: it is shown
            // once and only its hash is stored, so leaving it under a form for
            // the next one reads as if it were still on offer.
            setCreated(undefined);
            setShareForm((open) =>
              open ? undefined : { label: '', days: 30, allowDownload: true },
            );
          }}
        >
          {shareForm ? 'Cancel' : 'Share roll'}
        </button>
        )}

        {/* Safelight red because it destroys the roll — but not a photograph. */}
        {!isLibrary && photos && (
          <button className="btn btn-danger" disabled={batching} onClick={deleteRoll}>
            Delete roll
          </button>
        )}
      </div>

      {/* Three fields is one dialog too many for the window.prompt convention the
          rest of this view uses, so the create flow is inline instead. */}
      {shareForm && (
        <div style={{ padding: '16px 24px' }} className="stack">
          <div className="share-form">
            <div className="field">
              <label htmlFor="share-label">Label</label>
              <input
                id="share-label"
                type="text"
                placeholder="for mum"
                value={shareForm.label}
                onChange={(e) => setShareForm({ ...shareForm, label: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="share-days">Expires in (days)</label>
              <input
                id="share-days"
                type="number"
                min={1}
                max={365}
                value={shareForm.days}
                onChange={(e) =>
                  setShareForm({ ...shareForm, days: Number(e.target.value) })
                }
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={shareForm.allowDownload}
                onChange={(e) =>
                  setShareForm({ ...shareForm, allowDownload: e.target.checked })
                }
              />
              Allow downloads
            </label>
            {/* There is no <form>, so min/max above only drive the spinner —
                nothing validates on click. Guarding here instead of leaning on
                the server's clamp, which turns a cleared field into a 1-day
                link and a non-numeric one into 30, both without a word. */}
            <button
              className="btn"
              disabled={!Number.isInteger(shareForm.days) || shareForm.days < 1}
              onClick={share}
            >
              Create link
            </button>
          </div>
        </div>
      )}

      {created && (
        <div style={{ padding: '16px 24px' }} className="stack">
          <label htmlFor="share-url">
            Share link, expires in {created.expiresInDays}
            {created.expiresInDays === 1 ? ' day' : ' days'}
          </label>
          <div className="share-link" id="share-url">
            {created.url}
          </div>
          <div>
            <button
              className="btn"
              onClick={() => navigator.clipboard.writeText(created.url)}
            >
              Copy link
            </button>
          </div>
          <p className="note">Copy it now. Only its hash is stored, so this is the
            one time it can be shown.</p>
        </div>
      )}

      {shares && shares.length > 0 && (
        <div style={{ padding: '16px 24px' }} className="stack">
          <div className="shares-scroll">
            <table className="shares">
            <thead>
              <tr>
                <th>Label</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Download</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shares.map((link) => {
                // Expired links stay listed rather than filtered out: DynamoDB TTL
                // deletion lags up to 48h, and a row that quietly vanishes hours
                // later looks like a bug. Greyed, so the lag is visible instead.
                const { expired, label } = expiry(link.expiresAt);
                return (
                  <tr key={link.id} className={expired ? 'expired' : undefined}>
                    <td>{link.label ?? '·'}</td>
                    <td>{dayMonthYear(link.createdAt)}</td>
                    <td>{label}</td>
                    <td>{link.allowDownload ? 'yes' : 'no'}</td>
                    <td>
                      <button className="btn btn-danger" onClick={() => revokeShare(link)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
          <p className="note">
            A share URL is shown once, when it is created. Only its SHA-256 is
            stored, so no link can be listed here. Revoke one and make another.
          </p>
        </div>
      )}

      {status && <p className="note" style={{ padding: '16px 24px' }}>{status}</p>}
      {error && <p className="error" style={{ padding: '16px 24px' }}>{error}</p>}

      {!shown ? (
        <div className="empty">
          <p className="note">Loading…</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <h2>{isLibrary ? 'No photos yet' : 'Empty roll'}</h2>
          <p className="note">
            {isLibrary
              ? 'Add photos from the roll index. JPEGs and RAFs with matching ' +
                'filenames become one frame.'
              : 'Nothing here yet. Select frames in All photos and add them to this roll.'}
          </p>
        </div>
      ) : (
        <ContactSheet
          photos={shown}
          selected={selected}
          onOpen={setOpenIndex}
          onToggle={toggle}
        />
      )}

      {/* Selection actions act on the selection, not on the roll, so they get
          their own bar at the foot of the sheet rather than appearing and
          disappearing inside the roll's toolbar. */}
      {selected.size > 0 && (
        <div className="toolbar toolbar-footer">
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
          {/* Adds, never moves — a frame can be in several rolls. Needs at
              least one roll that is not the one being looked at. */}
          {(folders ?? []).some((f) => f.folderId !== current.folderId) && (
            <button className="btn" disabled={batching} onClick={addToRoll}>
              Add to roll…
            </button>
          )}
          {/* Exactly one of these two, never both. Inside a roll the answer to
              "get rid of this" is almost always "take it out of this roll", and
              the destructive twin sitting beside it is a misclick that loses a
              negative. Destroying a photograph is offered from All photos only,
              where it is unambiguous — there is no roll to have meant instead. */}
          {isLibrary ? (
            <button className="btn btn-danger" disabled={batching} onClick={destroySelected}>
              Delete photos
            </button>
          ) : (
            <button className="btn" disabled={batching} onClick={removeFromRoll}>
              Remove from roll
            </button>
          )}
          <div className="spacer" />
          <button className="btn" onClick={clear}>
            Clear
          </button>
        </div>
      )}

      {openIndex !== undefined && shown && (
        <Lightbox
          photos={shown}
          index={openIndex}
          onClose={() => setOpenIndex(undefined)}
          onNavigate={setOpenIndex}
          onDownload={download}
          // Same split as the footer: destroying a frame is an All photos
          // action, setting a cover is a roll one. Neither view offers both.
          onDelete={isLibrary ? removePhoto : undefined}
          onSetCover={isLibrary ? undefined : setCover}
        />
      )}
    </>
  );
}
