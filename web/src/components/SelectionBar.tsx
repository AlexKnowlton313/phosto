import {
  NEW_ROLL,
  downloadEach,
  type AdminApi,
  type FolderView,
  type MembershipResult,
  type PhotoView,
} from '../api';
import { useDialog } from './Dialog';
import { selectable } from './selection';

interface Props {
  api: AdminApi;
  /** The roll being looked at, or the synthesised All photos pseudo-roll. */
  folder: FolderView;
  isLibrary: boolean;
  folders?: FolderView[];
  photos: PhotoView[];
  selected: Set<string>;
  clear: () => void;
  /** Narrows the selection to these — what a partly-failed download leaves behind. */
  retain: (photoIds: string[]) => void;
  /** Re-reads the sheet after anything that changes what is on it. */
  refresh: () => Promise<void>;
  /** Counts and covers move under these, so the roll list has to be re-read. */
  reloadFolders: () => Promise<void>;
  setStatus: (message?: string) => void;
  setError: (message?: string) => void;
  /** A frame that has just left the sheet must not stay open in the lightbox. */
  closeLightbox: () => void;
  /**
   * Held above so the roll toolbar can grey itself out too: a batch runs for
   * seconds with no feedback of its own, which makes a second click likely — and
   * two concurrent loops are exactly the burst the 150ms gap between downloads
   * exists to avoid.
   */
  batching: boolean;
  setBatching: (batching: boolean) => void;
}

/**
 * Reports what a membership change actually did.
 *
 * `failed` frames are named rather than counted: the selection is cleared either
 * way, so a bare number would leave the owner unable to tell which ones to try
 * again. `already` is not an error — it is how re-adding an overlapping selection
 * behaves — but saying so beats silently reporting fewer than were selected.
 */
const membershipNote = (
  { changed, already, failed }: MembershipResult,
  verb: string,
  rollName: string,
  photos: PhotoView[],
) => {
  if (failed.length > 0) {
    const names = failed.map(
      (f) => photos.find((p) => p.photoId === f.photoId)?.basename ?? f.photoId,
    );
    return `${verb} ${changed.length}, but ${failed.length} failed: ${names.join(', ')}`;
  }
  const skipped = already.length > 0 ? ` (${already.length} already there)` : '';
  const preposition = verb === 'Removed' ? 'from' : 'to';
  return `${verb} ${changed.length} frame(s) ${preposition} ${rollName}${skipped}`;
};

/**
 * What can be done to a selection. Its own sticky bar at the foot of the sheet
 * rather than buttons in the roll toolbar: these act on the selection, not on
 * the roll. Sticky and not fixed so it reserves its own space and cannot cover
 * the last row of frames.
 */
export function SelectionBar({
  api,
  folder,
  isLibrary,
  folders,
  photos,
  selected,
  clear,
  retain,
  refresh,
  reloadFolders,
  setStatus,
  setError,
  closeLightbox,
  batching,
  setBatching,
}: Props) {
  const { confirm, choose, prompt, dialog } = useDialog();

  const downloadSelected = async (kind: 'original' | 'raw') => {
    setError(undefined);
    setBatching(true);
    // Whatever did not land stays selected; everything else is cleared, so the
    // same button is the retry.
    const { failed, note } = await downloadEach(
      selectable(photos, selected, kind),
      (photo) => api.download(photo.photoId, kind),
      setStatus,
    );
    setStatus(note);
    retain(failed);
    setBatching(false);
  };

  /**
   * Puts the selection into another roll. A frame can be in as many rolls as you
   * like, so this adds rather than moves — it leaves the current roll untouched,
   * and there is no destination it could fail to reach.
   *
   * The destination can be a roll that does not exist yet: filing an import is
   * the one moment you know what the roll should be called, and leaving to make
   * it costs the selection you came with.
   */
  const addToRoll = async () => {
    const others = (folders ?? []).filter((f) => f.folderId !== folder.folderId);

    // Which rolls already hold some of this selection. Re-adding is a harmless
    // no-op, so a failure here costs a hint and nothing else — show the picker
    // without the notes rather than refuse to open it.
    const counts = await api
      .photoMemberships([...selected])
      .then((r) => r.counts)
      .catch(() => ({}) as Record<string, number>);

    const choice = await choose({
      title: `Add ${selected.size} frame(s) to…`,
      body: 'The frames stay where they are — a frame can be in several rolls.',
      options: [
        { id: NEW_ROLL, name: 'New roll…' },
        ...others.map((f) => ({
          id: f.folderId,
          name: f.name,
          note:
            counts[f.folderId] === undefined
              ? undefined
              : counts[f.folderId] === selected.size
                ? 'all already in'
                : `${counts[f.folderId]} already in`,
        })),
      ],
    });
    if (!choice) return;

    let target = others.find((f) => f.folderId === choice);
    if (choice === NEW_ROLL) {
      const name = await prompt({ title: 'Name this roll', confirmLabel: 'Create' });
      if (!name) return;
      // reloadFolders below is what puts it in the shell's list; nothing
      // navigates, because the selection is still on the sheet behind this.
      target = await api.createFolder(name);
    }
    if (!target) return;

    setError(undefined);
    setBatching(true);
    try {
      const result = await api.attachPhotos(target.folderId, [...selected]);
      setStatus(membershipNote(result, 'Added', target.name, photos));
      clear();
      await reloadFolders();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBatching(false);
    }
  };

  /** Takes the selection out of this roll. The photographs are untouched. */
  const removeFromRoll = async () => {
    setError(undefined);
    setBatching(true);
    try {
      const result = await api.detachPhotos(folder.folderId, [...selected]);
      setStatus(membershipNote(result, 'Removed', folder.name, photos));
      clear();
      closeLightbox();
      await refresh();
      // The count changed, and removing the cover frame cleared it.
      await reloadFolders();
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
    const ok = await confirm({
      title: `Permanently delete ${ids.length} photograph(s)?`,
      body:
        'This removes the originals and RAWs from every roll they are in. To ' +
        'take them out of one roll, open that roll and use Remove from roll.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    setError(undefined);
    setBatching(true);
    let done = 0;
    try {
      // One at a time, deliberately. Deleting a photo unpicks its memberships,
      // and each of those is a transaction that bumps the roll's photoCount —
      // so two frames from the same roll deleted at once contend on one item
      // and the loser comes back a TransactionConflictException.
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
      closeLightbox();
      setBatching(false);
      await refresh();
      await reloadFolders();
    }
  };

  return (
    <div className="toolbar toolbar-footer">
      <span className="note">{selected.size} selected</span>
      {selectable(photos, selected, 'original').length > 0 && (
        <button
          type="button"
          className="btn"
          disabled={batching}
          onClick={() => downloadSelected('original')}
        >
          Download JPEGs
        </button>
      )}
      {selectable(photos, selected, 'raw').length > 0 && (
        <button
          type="button"
          className="btn btn-negatives"
          disabled={batching}
          onClick={() => downloadSelected('raw')}
        >
          Download RAWs
        </button>
      )}
      {/* Adds, never moves — a frame can be in several rolls. Always offered:
          the picker can make the roll, so there is no "no destination" case. */}
      <button type="button" className="btn" disabled={batching} onClick={addToRoll}>
        Add to roll…
      </button>
      {/* Exactly one of these two, never both. Inside a roll the answer to "get
          rid of this" is almost always "take it out of this roll", and the
          destructive twin sitting beside it is a misclick that loses a negative.
          Destroying a photograph is offered from All photos only, where it is
          unambiguous — there is no roll it could have meant instead. */}
      {isLibrary ? (
        <button
          type="button"
          className="btn btn-danger"
          disabled={batching}
          onClick={destroySelected}
        >
          Delete photos
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={batching}
          onClick={removeFromRoll}
        >
          Remove from roll
        </button>
      )}
      <div className="spacer" />
      <button type="button" className="btn" onClick={clear}>
        Clear
      </button>
      {dialog}
    </div>
  );
}
