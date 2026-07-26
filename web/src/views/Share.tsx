import { useEffect, useState } from 'react';
import { saveAs, shareApi, type ShareView } from '../api';
import {
  ContactSheet,
  EdgeHeader,
  selectable,
  useSelection,
} from '../components/ContactSheet';
import { Lightbox } from '../components/Lightbox';

export function Share({ token }: { token: string }) {
  const [data, setData] = useState<ShareView>();
  const [error, setError] = useState<string>();
  const [openIndex, setOpenIndex] = useState<number>();
  const { selected, toggle, clear } = useSelection();
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

  if (!data) {
    return (
      <div className="empty">
        <p className="note">Loading…</p>
      </div>
    );
  }

  const download = async (photoId: string) => {
    saveAs(await shareApi.download(token, photoId));
  };

  const downloadable = selectable(data.photos, selected, 'original');

  const downloadSelected = async () => {
    setError(undefined);
    setBatching(true);

    try {
      for (const photo of downloadable) {
        // Signed one at a time, immediately before its download: DOWNLOAD_TTL is
        // five minutes and a long batch would outlive URLs minted up front.
        saveAs(await shareApi.download(token, photo.photoId));
        // Browsers silently drop a burst of programmatic downloads.
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (err) {
      // Stop on the first failure rather than marching through the rest: these
      // fail as a group — an expired link refuses every remaining frame too.
      setError(`Download stopped: ${(err as Error).message}`);
    } finally {
      setBatching(false);
    }
  };

  return (
    <>
      <EdgeHeader name={data.folder.name} photos={data.photos} />

      {selected.size > 0 && (
        <div className="toolbar">
          <span className="note">{selected.size} selected</span>
          {data.permissions.allowDownload && downloadable.length > 0 && (
            <button className="btn" disabled={batching} onClick={downloadSelected}>
              Download JPEGs
            </button>
          )}
          <button className="btn" onClick={clear}>
            Clear
          </button>
        </div>
      )}

      {error && <p className="error" style={{ padding: '16px 24px' }}>{error}</p>}

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
