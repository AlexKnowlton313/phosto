import { useCallback, useEffect, useState } from 'react';
import {
  LIBRARY_ID,
  saveAs,
  type AdminApi,
  type FolderView,
  type PhotoView,
} from '../api';
import { ContactSheet, EdgeHeader, SkeletonSheet } from '../components/ContactSheet';
import { useDialog } from '../components/Dialog';
import { Lightbox } from '../components/Lightbox';
import { SelectionBar } from '../components/SelectionBar';
import { SharePanel } from '../components/SharePanel';
import { useSelection } from '../components/selection';

interface Props {
  api: AdminApi;
  /** The roll being looked at, or the synthesised All photos pseudo-roll. */
  folder: FolderView;
  isLibrary: boolean;
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
  folders,
  onFolderUpdated,
  reloadFolders,
}: Props) {
  // undefined until the first listPhotos lands — an empty array is a real
  // answer ("empty roll"), and the two must not render the same.
  const [photos, setPhotos] = useState<PhotoView[]>();
  const [openIndex, setOpenIndex] = useState<number>();
  const [sharing, setSharing] = useState(false);
  // Owned here rather than in the selection bar so this toolbar can grey out
  // while a batch runs — leaving the roll mid-delete is not a thing to offer.
  const [batching, setBatching] = useState(false);
  const [error, setError] = useState<string>();
  // What a batch actually did — "Added 12 frame(s) to Iceland (3 already there)",
  // or a running count while a long delete works through the selection.
  const [status, setStatus] = useState<string>();
  const { selected, toggle, clear, retain } = useSelection();
  const { confirm, prompt, dialog } = useDialog();

  const folderId = folder.folderId;

  const refresh = useCallback(async () => {
    const { photos } = await (folderId === LIBRARY_ID
      ? api.listLibrary()
      : api.listPhotos(folderId));
    setPhotos(photos);
    // Here rather than after a delete: any refresh can drop a photo, and a
    // selection holding a deleted id keeps the sheet in selection mode with
    // nothing visibly marked and no obvious way out.
    retain(photos.map((p) => p.photoId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, [refresh]);

  // Derivatives land a few seconds after upload, so poll while any are pending.
  useEffect(() => {
    if (!photos || photos.every((p) => p.ready)) return;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [photos, refresh]);

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

  const setCover = async (photo: PhotoView) => {
    onFolderUpdated(await api.updateFolder(folderId, { coverPhotoId: photo.photoId }));
    setOpenIndex(undefined);
  };

  const removePhoto = async (photo: PhotoView) => {
    const ok = await confirm({
      title: `Permanently delete ${photo.basename}?`,
      body: 'This removes the original and RAW from every roll it is in.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await api.destroyPhoto(photo.photoId);
    setOpenIndex(undefined);
    await refresh();
    await reloadFolders();
  };

  const download = async (photo: PhotoView, kind: 'original' | 'raw') => {
    saveAs(await api.download(photo.photoId, kind));
  };

  return (
    <>
      {/* The library is not a folder: nothing to rename. */}
      <EdgeHeader
        name={folder.name}
        photos={photos ?? []}
        onRename={isLibrary ? undefined : renameRoll}
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

        <div className="spacer" />

        {!isLibrary && (
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
        {!isLibrary && photos && (
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

      {!isLibrary && (
        <SharePanel
          api={api}
          folderId={folderId}
          open={sharing}
          onClose={() => setSharing(false)}
        />
      )}

      {status && <p className="note" style={{ padding: '16px 24px' }}>{status}</p>}
      {error && <p className="error" style={{ padding: '16px 24px' }}>{error}</p>}

      {!photos ? (
        <SkeletonSheet />
      ) : photos.length === 0 ? (
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
          photos={photos}
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
          folders={folders}
          photos={photos ?? []}
          selected={selected}
          clear={clear}
          refresh={refresh}
          reloadFolders={reloadFolders}
          setStatus={setStatus}
          setError={setError}
          closeLightbox={() => setOpenIndex(undefined)}
          batching={batching}
          setBatching={setBatching}
        />
      )}

      {openIndex !== undefined && photos && (
        <Lightbox
          photos={photos}
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

      {dialog}
    </>
  );
}
