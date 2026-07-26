import { useEffect, useState } from 'react';
import { saveAs, shareApi, type ShareView } from '../api';
import { ContactSheet, EdgeHeader } from '../components/ContactSheet';
import { Lightbox } from '../components/Lightbox';

export function Share({ token }: { token: string }) {
  const [data, setData] = useState<ShareView>();
  const [error, setError] = useState<string>();
  const [openIndex, setOpenIndex] = useState<number>();

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

  if (error) {
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

  return (
    <>
      <EdgeHeader name={data.folder.name} photos={data.photos} />

      {data.photos.length === 0 ? (
        <div className="empty">
          <h2>Nothing here yet</h2>
          <p className="note">This folder has no finished photos.</p>
        </div>
      ) : (
        <ContactSheet photos={data.photos} onOpen={setOpenIndex} />
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
