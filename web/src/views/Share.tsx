import { useEffect, useState } from 'react';
import { shareApi, type ShareView } from '../api';
import { ContactSheet, EdgeHeader } from '../components/ContactSheet';
import { Lightbox } from '../components/Lightbox';

export function Share({ token }: { token: string }) {
  const [data, setData] = useState<ShareView>();
  const [error, setError] = useState<string>();
  const [showNegatives, setShowNegatives] = useState(false);
  const [openIndex, setOpenIndex] = useState<number>();

  useEffect(() => {
    shareApi
      .open(token)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [token]);

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

  const download = async (photoId: string, kind: 'original' | 'raw') => {
    const { url } = await shareApi.download(token, photoId, kind);
    window.location.href = url;
  };

  const rawFrames = data.photos.filter((p) => p.hasRaw).length;
  const hasNegatives = data.permissions.allowRaw && rawFrames > 0;

  return (
    <>
      <EdgeHeader name={data.folder.name} photos={data.photos} />

      {hasNegatives && (
        <div className="toolbar">
          <button
            className="btn btn-negatives"
            aria-pressed={showNegatives}
            onClick={() => setShowNegatives((on) => !on)}
          >
            {showNegatives ? 'Hide negatives' : 'Show negatives'}
          </button>
          <span className="note">
            {rawFrames === 1
              ? '1 frame has a RAW file'
              : `${rawFrames} frames have a RAW file`}
          </span>
        </div>
      )}

      {data.photos.length === 0 ? (
        <div className="empty">
          <h2>Nothing here yet</h2>
          <p className="note">This folder has no finished photos.</p>
        </div>
      ) : (
        <ContactSheet
          photos={data.photos}
          showNegatives={showNegatives}
          onOpen={setOpenIndex}
        />
      )}

      {openIndex !== undefined && (
        <Lightbox
          photos={data.photos}
          index={openIndex}
          showNegatives={showNegatives}
          onClose={() => setOpenIndex(undefined)}
          onNavigate={setOpenIndex}
          onDownload={(photo, kind) => download(photo.photoId, kind)}
        />
      )}
    </>
  );
}
