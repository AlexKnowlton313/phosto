import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LIBRARY_ID,
  NOTE_MAX,
  TRASH_ID,
  saveAs,
  type AdminApi,
  type FolderView,
  type PhotoView,
} from '../api';
import {
  ContactSheet,
  EdgeHeader,
  EmptySheet,
  SkeletonSheet,
} from '../components/ContactSheet';
import { useDialog } from '../components/Dialog';
import { filterPhotos, filtersActive, NO_FILTERS, rollNames } from '../components/filters';
import { Lightbox } from '../components/Lightbox';
import { SelectionBar } from '../components/SelectionBar';
import { SharePanel } from '../components/SharePanel';
import { useSelection } from '../components/selection';
import { SheetFilters } from '../components/SheetFilters';

/**
 * The pending-frame poll, bounded.
 *
 * ponytail: a fixed ceiling rather than exponential backoff. Derivatives land in
 * seconds; anything still pending after two minutes is stuck, not slow. The
 * ceiling is the point — a frame that can *never* develop (a RAW-only .CR3 has
 * no preview extractor) had an open tab re-reading the whole library every four
 * seconds indefinitely: ~900 calls an hour, which is more DynamoDB read than the
 * entire gallery costs in a month. Raise the count if a slow batch ever outruns
 * it; do not remove it.
 */
const POLL_MS = 4000;
const POLL_ROUNDS = 30;

/**
 * Re-reads the sheet while any frame is still undeveloped, up to the ceiling.
 *
 * Derivatives land a few seconds after upload, so this polls while any are
 * pending. Each tick bumps the round count, which re-runs the effect and
 * restarts the timer — so the ceiling is reached by counting rounds rather than
 * by keeping a second clock.
 *
 * `stalled` is what the caller shows instead of a spinner that lies, and
 * `restart` puts the poll back on after *Check again* or a re-develop.
 */
function usePendingPoll(
  photos: PhotoView[] | undefined,
  refresh: () => Promise<void>,
  onError: (message: string) => void,
) {
  const [rounds, setRounds] = useState(0);
  const pending = photos?.filter((p) => !p.ready).length ?? 0;

  useEffect(() => {
    if (pending === 0 || rounds >= POLL_ROUNDS) return;
    const timer = setInterval(() => {
      setRounds((n) => n + 1);
      refresh().catch((err: Error) => onError(err.message));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, rounds, refresh, onError]);

  return {
    pending,
    stalled: pending > 0 && rounds >= POLL_ROUNDS,
    restart: () => setRounds(0),
  };
}

/** Bin size, in whichever unit reads as a quantity rather than a digit string. */
const humanBytes = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;

interface Props {
  api: AdminApi;
  /** The roll being looked at, or one of the two synthesised pseudo-rolls. */
  folder: FolderView;
  isLibrary: boolean;
  isTrash: boolean;
  folders?: FolderView[];
  onFolderUpdated: (folder: FolderView) => void;
  reloadFolders: () => Promise<void>;
}

/**
 * One roll's contact sheet, and everything that can be done from inside it.
 *
 * Mounted per roll — `key={folder.folderId}` in Admin — so changing rolls throws
 * this state away rather than unsetting it field by field. The sheet, the open
 * frame, the selection and the status line all describe the roll that was open,
 * and none of them survives leaving it.
 */
export function RollView({
  api,
  folder,
  isLibrary,
  isTrash,
  folders,
  onFolderUpdated,
  reloadFolders,
}: Props) {
  // Neither pseudo-roll has a folder record, so neither can be renamed, given a
  // note, reordered, shared or deleted. One name for "this is a real roll"
  // rather than a growing `!isLibrary && !isTrash` at each of those.
  const isRoll = !isLibrary && !isTrash;
  // undefined until the first listPhotos lands — an empty array is a real
  // answer ("empty roll"), and the two must not render the same.
  const [photos, setPhotos] = useState<PhotoView[]>();
  // Which rolls each photo is in. Only ever fetched for All photos — a roll
  // already knows its own membership, and this is the one thing the library
  // payload cannot answer.
  const [memberships, setMemberships] = useState<Record<string, string[]>>();
  // What the bin is costing, straight off the trash payload. Trash only.
  const [trashBytes, setTrashBytes] = useState<number>();
  const [filters, setFilters] = useState(NO_FILTERS);
  const [openIndex, setOpenIndex] = useState<number>();
  const [sharing, setSharing] = useState(false);
  // Owned here rather than in the selection bar so this toolbar can grey out
  // while a batch runs — leaving the roll mid-delete is not a thing to offer.
  const [batching, setBatching] = useState(false);
  const [error, setError] = useState<string>();
  // What a batch actually did — "Added 12 frame(s) to Iceland (3 already there)",
  // or a running count while a long delete works through the selection.
  const [status, setStatus] = useState<string>();
  const { selected, setSelected, toggle, clear, retain } = useSelection();
  const { confirm, prompt, dialog } = useDialog();

  const folderId = folder.folderId;

  const refresh = useCallback(async () => {
    // Together, not in sequence: two independent reads, and the sheet should
    // not wait a second round trip to draw. Riding on refresh rather than its
    // own effect is what keeps memberships current after an attach or a delete,
    // both of which already call this.
    // Annotated rather than inferred: `{ photos, bytes }` is a subtype of
    // `{ photos }`, so a bare ternary reduces the union to the wider one and
    // loses `bytes` entirely. Optional here says only the trash sends it.
    const sheet: Promise<{ photos: PhotoView[]; bytes?: number }> =
      folderId === TRASH_ID
        ? api.listTrash()
        : folderId === LIBRARY_ID
          ? api.listLibrary()
          : api.listPhotos(folderId);

    const [{ photos, bytes }, membership] = await Promise.all([
      sheet,
      folderId === LIBRARY_ID ? api.listMemberships() : undefined,
    ]);
    setPhotos(photos);
    setMemberships(membership?.memberships);
    setTrashBytes(bytes);
    // Here rather than after a delete: any refresh can drop a photo, and a
    // selection holding a deleted id keeps the sheet in selection mode with
    // nothing visibly marked and no obvious way out.
    retain(photos.map((p) => p.photoId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  // What is actually on the sheet. Frame numbers run over this, which is
  // correct: a contact sheet numbers what is printed on it — so the roll's
  // order is applied here, and All photos stays newest-first: it is an inbox,
  // and it has no folder record to hold the field.
  const visible = useMemo(() => {
    if (!photos) return photos;
    if (isLibrary) return filterPhotos(photos, filters, memberships);
    // Already in thrown-away order, which is the order the trash is read in.
    if (isTrash) return photos;
    // The API returns newest-first; reversing is the ascending sort.
    return folder.sortOrder === 'oldest' ? [...photos].reverse() : photos;
  }, [isLibrary, isTrash, photos, filters, memberships, folder.sortOrder]);

  // Over `visible`, not `photos`: select-all means what is printed on the sheet,
  // the same list the frame numbers and the lightbox run over.
  const allSelected =
    !!visible?.length && visible.every((p) => selected.has(p.photoId));

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, [refresh]);

  // Not in the trash: an undeveloped frame in the bin is not waiting on
  // anything, and polling it would re-read the whole library for no answer.
  const { pending, stalled, restart } = usePendingPoll(
    isTrash ? undefined : photos,
    refresh,
    setError,
  );

  const checkAgain = () => {
    restart();
    refresh().catch((err: Error) => setError(err.message));
  };

  const renameRoll = async () => {
    // Whitespace-only cancels rather than clearing the name — the dialog resolves
    // a blank as null. The API refuses it too, so this only saves the round trip.
    const name = await prompt({
      title: 'Rename this roll',
      value: folder.name,
      confirmLabel: 'Rename',
    });
    if (!name) return;
    onFolderUpdated(await api.updateFolder(folderId, { name }));
  };

  /**
   * The roll's line about itself. Blank is a real answer here and clears it —
   * only cancelling returns null — which is why this checks for null rather
   * than falsiness the way renameRoll does.
   */
  const editNote = async () => {
    const note = await prompt({
      title: 'A line about this roll',
      body: 'Shown on the share link and in its preview. Leave blank to remove it.',
      value: folder.note ?? '',
      multiline: true,
      maxLength: NOTE_MAX,
      confirmLabel: 'Save',
    });
    if (note === null) return;
    onFolderUpdated(await api.updateFolder(folderId, { note }));
  };

  /**
   * Drops the roll. No frame is at risk: a roll holds pointers, so the
   * photographs stay in the library and in any other roll they are in.
   */
  const deleteRoll = async () => {
    if (!photos) return;

    const ok = await confirm({
      title: `Delete the roll “${folder.name}” and its share links?`,
      body: `The ${photos.length} frame(s) in it stay in All photos.`,
      confirmLabel: 'Delete roll',
      danger: true,
    });
    if (!ok) return;

    setError(undefined);
    try {
      await api.deleteFolder(folderId);
      await reloadFolders();
      location.hash = '';
    } catch (err) {
      setError((err as Error).message);
      await refresh();
    }
  };

  const flipOrder = async () =>
    onFolderUpdated(
      await api.updateFolder(folderId, {
        sortOrder: folder.sortOrder === 'oldest' ? 'newest' : 'oldest',
      }),
    );

  const setCover = async (photo: PhotoView) => {
    onFolderUpdated(await api.updateFolder(folderId, { coverPhotoId: photo.photoId }));
    setOpenIndex(undefined);
  };

  /**
   * Throws one frame away. Not safelight red and it no longer says permanently,
   * because it is not: the frame goes to the trash with its bytes intact and
   * comes back from there. Emptying the trash is the irreversible half.
   */
  const removePhoto = async (photo: PhotoView) => {
    const ok = await confirm({
      title: `Move ${photo.basename} to the trash?`,
      body: 'It leaves every roll it is in. Restore it from Trash to put it back.',
      confirmLabel: 'Move to trash',
    });
    if (!ok) return;
    await api.trashPhoto(photo.photoId);
    setOpenIndex(undefined);
    await refresh();
    await reloadFolders();
  };

  /** Back into the library, and into whichever of its old rolls still exist. */
  const restorePhoto = async (photo: PhotoView) => {
    setOpenIndex(undefined);
    await api.restorePhoto(photo.photoId);
    await refresh();
    await reloadFolders();
  };

  /**
   * Re-fires derive for one frame. The API copies the source onto itself and
   * returns; the derivatives arrive seconds later, so put the poll back on.
   */
  const develop = async (photo: PhotoView) => {
    setOpenIndex(undefined);
    setStatus(`Developing ${photo.basename} again…`);
    try {
      await api.develop(photo.photoId);
      restart();
    } catch (err) {
      setStatus(undefined);
      setError((err as Error).message);
    }
  };

  const download = async (photo: PhotoView, kind: 'original' | 'raw') => {
    saveAs(await api.download(photo.photoId, kind));
  };

  return (
    <>
      {/* The library is not a folder: nothing to rename. Reads off the filtered
          sheet, so the data line describes what is actually printed. */}
      <EdgeHeader
        name={folder.name}
        photos={visible ?? []}
        note={folder.note}
        onRename={isRoll ? renameRoll : undefined}
        onEditNote={isRoll ? editNote : undefined}
      />

      <div className="toolbar">
        <button
          type="button"
          className="btn"
          disabled={batching}
          onClick={() => (location.hash = '')}
        >
          ← All rolls
        </button>

        {/* Here and not in SelectionBar: the bar only exists once something is
            selected, so it cannot be the way *in* to a selection. */}
        {visible && visible.length > 0 && (
          <button
            type="button"
            className="btn"
            disabled={batching}
            onClick={() =>
              allSelected
                ? clear()
                : setSelected(new Set(visible.map((p) => p.photoId)))
            }
          >
            {allSelected ? 'Select none' : `Select all ${visible.length}`}
          </button>
        )}

        <div className="spacer" />

        {/* A roll is a sequence; All photos is an inbox and has no record to
            hold the field. Label says the order it is in, not the one it would
            switch to. */}
        {isRoll && (
          <button
            type="button"
            className="btn btn-order"
            data-order={folder.sortOrder ?? 'newest'}
            disabled={batching}
            onClick={flipOrder}
          >
            {/* One glyph, rotated by CSS — the flip *is* the icon, and it points
                the way the sheet runs. */}
            <span className="order-arrow" aria-hidden="true">
              ↓
            </span>
            {folder.sortOrder === 'oldest' ? 'Oldest first' : 'Newest first'}
          </button>
        )}

        {isRoll && (
          <button
            type="button"
            className="btn"
            disabled={batching}
            onClick={() => setSharing((s) => !s)}
          >
            {sharing ? 'Cancel' : 'Share roll'}
          </button>
        )}

        {/* Safelight red because it destroys the roll — but not a photograph. */}
        {isRoll && photos && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={batching}
            onClick={deleteRoll}
          >
            Delete roll
          </button>
        )}
      </div>

      {/* All photos only: a roll is already the narrowing, and "in no roll"
          cannot mean anything inside one. */}
      {isLibrary && photos && photos.length > 0 && (
        <SheetFilters
          photos={photos}
          value={filters}
          onChange={setFilters}
          memberships={memberships}
          shown={visible?.length ?? 0}
        />
      )}

      {/* What the bin holds and what it is costing. Nothing sweeps it on a
          timer — the trash is emptied by selecting frames and destroying them,
          so the number has to be visible or it is a bill found later. */}
      {isTrash && photos && photos.length > 0 && (
        <p className="note" style={{ padding: '16px 24px' }}>
          {photos.length} {photos.length === 1 ? 'frame' : 'frames'} in the trash
          {trashBytes !== undefined && ` · ${humanBytes(trashBytes)} still stored`}.
          Select frames to restore them, or to destroy them for good.
        </p>
      )}

      {isRoll && (
        <SharePanel
          api={api}
          folderId={folderId}
          open={sharing}
          onClose={() => setSharing(false)}
        />
      )}

      {stalled && (
        <p className="note" style={{ padding: '16px 24px' }}>
          {pending} {pending === 1 ? 'frame is' : 'frames are'} still undeveloped.
          Stopped checking — open one to develop it again.{' '}
          <button type="button" className="btn" onClick={checkAgain}>
            Check again
          </button>
        </p>
      )}

      {status && <p className="note" style={{ padding: '16px 24px' }}>{status}</p>}
      {error && <p className="error" style={{ padding: '16px 24px' }}>{error}</p>}

      {!visible || !photos ? (
        <SkeletonSheet />
      ) : visible.length === 0 ? (
        <EmptySheet
          isLibrary={isLibrary}
          isTrash={isTrash}
          filtered={photos.length > 0}
          unfiledOnly={filters.unfiled && !filtersActive({ ...filters, unfiled: false })}
        />
      ) : (
        <ContactSheet
          photos={visible}
          selected={selected}
          onOpen={setOpenIndex}
          onToggle={toggle}
        />
      )}

      {selected.size > 0 && (
        <SelectionBar
          api={api}
          folder={folder}
          isLibrary={isLibrary}
          isTrash={isTrash}
          folders={folders}
          photos={photos ?? []}
          selected={selected}
          clear={clear}
          retain={retain}
          refresh={refresh}
          reloadFolders={reloadFolders}
          setStatus={setStatus}
          setError={setError}
          closeLightbox={() => setOpenIndex(undefined)}
          batching={batching}
          setBatching={setBatching}
        />
      )}

      {openIndex !== undefined && visible && (
        <Lightbox
          photos={visible}
          index={openIndex}
          // Only All photos has the memberships to answer it, and it is the
          // view where "which rolls is this in" is the open question.
          rollsOf={
            isLibrary && memberships
              ? (photo) => rollNames(memberships, folders, photo.photoId)
              : undefined
          }
          onClose={() => setOpenIndex(undefined)}
          onNavigate={setOpenIndex}
          onDownload={download}
          // Same split as the footer: throwing a frame away is an All photos
          // action, setting a cover is a roll one. Neither view offers both,
          // and the trash offers neither — the only thing to do to a frame in
          // the bin is take it back out.
          onDelete={isLibrary ? removePhoto : undefined}
          onSetCover={isRoll ? setCover : undefined}
          onRestore={isTrash ? restorePhoto : undefined}
          // Not a roll action either way: it re-runs the pipeline on the
          // photograph. Pointless on a trashed frame, which is going nowhere.
          onDevelop={isTrash ? undefined : develop}
        />
      )}

      {dialog}
    </>
  );
}
