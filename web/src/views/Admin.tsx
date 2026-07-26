import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adminApi,
  ORPHAN_FOLDER_ID,
  saveAs,
  uploadFile,
  type AppConfig,
  type FolderView,
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

/** Mirrors the server's cap in `movePhotos`, which is bounded by a 15s timeout. */
const MOVE_BATCH = 10;

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
  // A chunked move runs for a minute on a full roll. Without a running count it
  // is indistinguishable from a hang, and the user's next move is a reload.
  const [status, setStatus] = useState<string>();
  const { selected, toggle, clear, retain } = useSelection();
  // A batch runs for seconds with no feedback of its own, which makes a second
  // click likely — and two concurrent loops are exactly the burst the 150ms gap
  // between downloads exists to avoid.
  const [batching, setBatching] = useState(false);
  // Deliberately not persisted, and reset on every folder change below: hidden
  // defaults to out of sight each time a roll is opened, which is the feature.
  const [showHidden, setShowHidden] = useState(false);
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

  const loadShares = useCallback(async () => {
    if (!folderId) return;
    setShares((await api.listShares(folderId)).shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, token]);

  useEffect(() => {
    setPhotos(undefined);
    setCreated(undefined);
    setShares(undefined);
    setShareForm(undefined);
    setOpenIndex(undefined);
    setShowHidden(false);
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

  const moveSelected = async () => {
    if (!current || !folders) return;
    const others = folders.filter((f) => f.folderId !== current.folderId);

    // Matches the server's cap. Said here rather than letting the 400 come back,
    // because by then the user has already picked a destination.
    if (selected.size > MOVE_BATCH) {
      setError(`Move up to ${MOVE_BATCH} frames at a time — ${selected.size} selected`);
      return;
    }

    // A numbered prompt rather than a dialog: one user, no modal infrastructure,
    // and every other choice in this app is already made this way.
    const answer = window.prompt(
      `Move ${selected.size} frame(s) to which roll?\n\n` +
        others.map((f, i) => `${i + 1}. ${f.name}`).join('\n'),
    );
    const target = others[Number(answer) - 1];
    if (!target) return;

    setError(undefined);
    setBatching(true);

    try {
      const ids = [...selected];
      const { moved, failed } = await api.movePhotos(
        current.folderId,
        ids,
        target.folderId,
      );
      if (failed.length > 0) {
        // Named, not counted: a move is per-photo, so the ones left behind are
        // the only thing worth retrying and the user has to know which they are.
        const names = failed.map(
          (f) => photos?.find((p) => p.photoId === f.photoId)?.basename ?? f.photoId,
        );
        setError(
          `Moved ${moved.length} of ${ids.length} to ${target.name}. Left behind: ${names.join(', ')}`,
        );
      }
      clear();
      setOpenIndex(undefined);
      await refresh();
      // Both rolls' photoCounts just changed, and `current` is read off this list.
      setFolders((await api.listFolders()).folders);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBatching(false);
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
   * Deleting a roll must never delete a photograph. An empty roll goes straight
   * away; one that still holds frames sends them to the orphan roll first, so
   * the destructive-looking button is only ever destructive to the folder.
   */
  const deleteRoll = async () => {
    if (!current || !photos) return;
    const ids = photos.map((p) => p.photoId);

    if (
      !window.confirm(
        ids.length === 0
          ? `Delete ${current.name}? The roll is empty.`
          : `${current.name} still holds ${ids.length} frame(s).\n\n` +
              'They move to the orphaned roll — nothing is deleted — and then ' +
              'this roll goes. Continue?',
      )
    ) {
      return;
    }

    setError(undefined);
    setBatching(true);

    try {
      // The server caps a move at 25 because each photo is a transaction plus S3
      // copies against a 15s timeout. A roll is 200 frames, so chunk to that cap
      // rather than moving what fits and leaving the rest behind unannounced.
      for (let i = 0; i < ids.length; i += MOVE_BATCH) {
        const chunk = ids.slice(i, i + MOVE_BATCH);
        setStatus(`Orphaning ${i + chunk.length} of ${ids.length} frames…`);
        const { failed } = await api.movePhotos(
          current.folderId,
          chunk,
          ORPHAN_FOLDER_ID,
        );
        // Stop here rather than pressing on to the delete: the roll must not be
        // removed while it still holds a frame that refused to move.
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} frame(s) stayed put (${failed[0].message}) — roll kept`,
          );
        }
      }

      setStatus(undefined);
      await api.deleteFolder(current.folderId);
      // Both the orphan roll's count and its very existence may have changed.
      setFolders((await api.listFolders()).folders);
      location.hash = '';
    } catch (err) {
      // Surfaces the API's own 409 text, including the count it names when a
      // bulk upload landed between this render and the click.
      setError((err as Error).message);
      await refresh();
    } finally {
      setStatus(undefined);
      setBatching(false);
    }
  };

  /**
   * One request per frame rather than a batch route: each is a couple of small
   * S3 copies, and separate requests mean no Lambda timeout to size a cap
   * against. Serial so a long selection does not open forty at once.
   */
  const setHidden = async (ids: string[], hidden: boolean) => {
    if (!current) return;
    setError(undefined);
    setBatching(true);

    try {
      for (const photoId of ids) {
        await api.setPhotoHidden(current.folderId, photoId, hidden);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      clear();
      setOpenIndex(undefined);
      setBatching(false);
      await refresh();
      // Hiding the cover frame clears it, so the roll list is now stale.
      setFolders((await api.listFolders()).folders);
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

  const hiddenCount = photos?.filter((p) => p.hidden).length ?? 0;
  // The sheet numbers whatever it is handed, one-based, so filtering here is also
  // what keeps the numbering gapless — a jump from 06 to 08 would advertise the
  // frame that was taken out, which is the opposite of the point.
  const shown = showHidden ? photos : photos?.filter((p) => !p.hidden);
  const selectedHidden = (photos ?? []).filter(
    (p) => selected.has(p.photoId) && p.hidden,
  ).length;

  return (
    <>
      {/* The orphan roll is an ordinary folder in every way but two: it is a
          fixture, so it cannot be renamed or deleted, and the server refuses
          both regardless of what this offers. */}
      <EdgeHeader
        name={current.name}
        photos={photos ?? []}
        onRename={current.folderId === ORPHAN_FOLDER_ID ? undefined : renameRoll}
      />

      <div className="toolbar">
        <button className="btn" disabled={batching} onClick={() => (location.hash = '')}>
          ← All rolls
        </button>

        <button className="btn" disabled={batching} onClick={() => fileInput.current?.click()}>
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
            {(folders?.length ?? 0) > 1 && (
              <button className="btn" disabled={batching} onClick={moveSelected}>
                Move to…
              </button>
            )}
            {/* Unhide only when every selected frame is already hidden, so a
                mixed selection cannot silently republish one of them. */}
            <button
              className="btn"
              disabled={batching}
              onClick={() => setHidden([...selected], selectedHidden !== selected.size)}
            >
              {selectedHidden === selected.size ? 'Unhide' : 'Hide'}
            </button>
            <button className="btn" onClick={clear}>
              Clear
            </button>
          </>
        )}

        <div className="spacer" />

        {hiddenCount > 0 && (
          <button
            className="btn"
            onClick={() => {
              // Turning the toggle off shrinks the sheet, so any hidden frame in
              // the selection would keep it in selection mode with nothing
              // visibly marked — the same drift `retain` exists to prevent.
              if (showHidden) retain((photos ?? []).filter((p) => !p.hidden).map((p) => p.photoId));
              setShowHidden((on) => !on);
            }}
          >
            {showHidden ? `Hide hidden (${hiddenCount})` : `Show hidden (${hiddenCount})`}
          </button>
        )}

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

        {photos && current.folderId !== ORPHAN_FOLDER_ID && (
          <button className="btn btn-danger" disabled={batching} onClick={deleteRoll}>
            {photos.length === 0 ? 'Delete roll' : 'Orphan frames & delete roll'}
          </button>
        )}
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
            Share link — expires in {created.expiresInDays}
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
          <p className="note">Copy it now — only its hash is stored, so this is the
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
                    <td>{link.label ?? '—'}</td>
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
            stored, so no link can be listed here — revoke one and make another.
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
          {/* A roll of nothing but hidden frames is not an empty roll, and telling
              the owner to add photos to one they can see with a click is a lie. */}
          <h2>{hiddenCount > 0 ? 'Nothing on the sheet' : 'Empty roll'}</h2>
          <p className="note">
            {hiddenCount > 0
              ? `Every frame on this roll is hidden (${hiddenCount}).`
              : 'Add JPEGs and RAFs together — matching filenames become one frame.'}
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

      {openIndex !== undefined && shown && (
        <Lightbox
          photos={shown}
          index={openIndex}
          onClose={() => setOpenIndex(undefined)}
          onNavigate={setOpenIndex}
          onDownload={download}
          onDelete={removePhoto}
          onSetCover={setCover}
          onSetHidden={(photo, hidden) => setHidden([photo.photoId], hidden)}
        />
      )}
    </>
  );
}
