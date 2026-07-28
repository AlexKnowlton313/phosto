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
  /** The roll being looked at, or one of the two synthesised pseudo-rolls. */
  folder: FolderView;
  isLibrary: boolean;
  isTrash: boolean;
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
  isTrash,
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
   * One call per frame, in order, reporting as it goes.
   *
   * Sequential deliberately, and the reason is the same for all three callers
   * below: trashing a photo unpicks its memberships and restoring re-attaches
   * them, each of which is a transaction that bumps the roll's `photoCount` —
   * so two frames from the same roll done at once contend on one item and the
   * loser comes back a TransactionConflictException. Destroying rides along
   * because it is the same shape and the same wind-down.
   */
  const runEach = async (
    ids: string[],
    verb: string,
    call: (photoId: string) => Promise<void>,
  ) => {
    setError(undefined);
    setBatching(true);
    let done = 0;
    try {
      for (const photoId of ids) {
        await call(photoId);
        done += 1;
        setStatus(`${verb} ${done} of ${ids.length}…`);
      }
    } catch (err) {
      setError(`${(err as Error).message} (${ids.length - done} left)`);
    } finally {
      setStatus(undefined);
      clear();
      closeLightbox();
      setBatching(false);
      await refresh();
      await reloadFolders();
    }
  };

  /**
   * Throws the selection away. Reversible now — the frames keep every byte and
   * sit in the trash until they are restored or destroyed — so this no longer
   * wears safelight red, and the confirm is about the rolls they leave rather
   * than about losing a negative.
   */
  const trashSelected = async () => {
    const ids = [...selected];
    const ok = await confirm({
      title: `Move ${ids.length} photograph(s) to the trash?`,
      body:
        'They leave every roll they are in and keep their originals and RAWs. ' +
        'Restore them from Trash, or destroy them there for good.',
      confirmLabel: 'Move to trash',
    });
    if (!ok) return;
    await runEach(ids, 'Moved', api.trashPhoto);
  };

  /** Back into the library, and into whichever of their old rolls still exist. */
  const restoreSelected = () => runEach([...selected], 'Restored', api.restorePhoto);

  /**
   * Destroys the photographs themselves — the only irreversible action in the
   * app. Offered from the trash and nowhere else, so nothing can reach it
   * without having thrown the frames away first and looked at them again.
   */
  const purgeSelected = async () => {
    const ids = [...selected];
    const ok = await confirm({
      title: `Permanently destroy ${ids.length} photograph(s)?`,
      body:
        'This deletes the originals, the RAWs and the previews. There is no ' +
        'copy anywhere and this cannot be undone.',
      confirmLabel: 'Destroy',
      danger: true,
    });
    if (!ok) return;
    await runEach(ids, 'Destroyed', api.purgePhoto);
  };

  // The trash has its own two, and shares none of the others: a frame in the
  // bin is not downloadable, and filing one into a roll would be filing
  // something that is not in the library.
  if (isTrash) {
    return (
      <div className="toolbar toolbar-footer">
        <span className="note">{selected.size} selected</span>
        <button
          type="button"
          className="btn"
          disabled={batching}
          onClick={restoreSelected}
        >
          Restore
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={batching}
          onClick={purgeSelected}
        >
          Destroy permanently
        </button>
        <div className="spacer" />
        <button type="button" className="btn" onClick={clear}>
          Clear
        </button>
        {dialog}
      </div>
    );
  }

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
          rid of this" is almost always "take it out of this roll", and the twin
          sitting beside it is a misclick. Throwing a photograph away is offered
          from All photos only, where it is unambiguous — there is no roll it
          could have meant instead. Neither one loses a negative any more: the
          only button that can is Destroy permanently, in the trash. */}
      {isLibrary ? (
        <button
          type="button"
          className="btn"
          disabled={batching}
          onClick={trashSelected}
        >
          Move to trash
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
