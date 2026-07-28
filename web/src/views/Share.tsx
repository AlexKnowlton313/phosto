import { useEffect, useState } from 'react';
import { downloadEach, saveAs, shareApi, type ShareView } from '../api';
import { ContactSheet, EdgeHeader, SkeletonSheet } from '../components/ContactSheet';
import { Lightbox } from '../components/Lightbox';
import { selectable, useSelection } from '../components/selection';

export function Share({ token }: { token: string }) {
  const [data, setData] = useState<ShareView>();
  const [error, setError] = useState<string>();
  const [openIndex, setOpenIndex] = useState<number>();
  /** Download progress, then its summary. Outlives the selection bar, which
      unmounts the moment a clean run clears the selection. */
  const [status, setStatus] = useState<string>();
  const { selected, toggle, clear, retain } = useSelection();
  const [batching, setBatching] = useState(false);

  useEffect(() => {
    shareApi
      .open(token)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [token]);

  // Tab label only — link unfurlers never run this, they read the static <title>.
  useEffect(() => {
    if (data) document.title = data.folder.name;
  }, [data]);

  // Only fatal before the folder lands — a failed download must not take the
  // gallery down with it.
  if (error && !data) {
    return (
      <div className="shell">
        <h1>Link closed</h1>
        <p className="note">{error}</p>
      </div>
    );
  }

  if (!data) return <SkeletonSheet />;

  const download = async (photoId: string) => {
    saveAs(await shareApi.download(token, photoId));
  };

  const downloadable = selectable(data.photos, selected, 'original');

  const downloadSelected = async () => {
    setError(undefined);
    setBatching(true);
    // Whatever did not land stays selected; everything else is cleared, so the
    // same button is the retry.
    const { failed, note } = await downloadEach(
      downloadable,
      (photo) => shareApi.download(token, photo.photoId),
      setStatus,
    );
    setStatus(note);
    retain(failed);
    setBatching(false);
  };

  return (
    <>
      <EdgeHeader name={data.folder.name} photos={data.photos} note={data.folder.note} />

      {(error ?? status) && (
        <p className={error ? 'error' : 'note'} style={{ padding: '16px 24px' }}>
          {error ?? status}
        </p>
      )}

      {data.photos.length === 0 ? (
        <div className="empty">
          <h2>Nothing here yet</h2>
          <p className="note">This folder has no finished photos.</p>
        </div>
      ) : (
        <ContactSheet
          photos={data.photos}
          selected={selected}
          onOpen={setOpenIndex}
          onToggle={toggle}
        />
      )}

      {/* Same bar as the admin sheet: it acts on the selection, so it sits at
          the foot of the frames rather than at the top of the page. */}
      {selected.size > 0 && (
        <div className="toolbar toolbar-footer">
          <span className="note">{selected.size} selected</span>
          {data.permissions.allowDownload && downloadable.length > 0 && (
            <button
              type="button"
              className="btn"
              disabled={batching}
              onClick={downloadSelected}
            >
              Download JPEGs
            </button>
          )}
          <div className="spacer" />
          <button type="button" className="btn" onClick={clear}>
            Clear
          </button>
        </div>
      )}

      {openIndex !== undefined && (
        <Lightbox
          photos={data.photos}
          index={openIndex}
          onClose={() => setOpenIndex(undefined)}
          onNavigate={setOpenIndex}
          onDownload={(photo) => download(photo.photoId)}
        />
      )}
    </>
  );
}
