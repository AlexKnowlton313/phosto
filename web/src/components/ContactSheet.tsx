import { useState } from 'react';
import type { PhotoView } from '../api';

interface Props {
  photos: PhotoView[];
  showNegatives: boolean;
  onOpen: (index: number) => void;
}

function Frame({
  photo,
  index,
  showNegatives,
  onOpen,
}: {
  photo: PhotoView;
  index: number;
  showNegatives: boolean;
  onOpen: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  // Frame numbers run in shooting order, one-based, the way they do on a roll.
  const frameNumber = String(index + 1).padStart(2, '0');

  return (
    // Cells stay a uniform 3:2 regardless of the frame's own aspect, which is how
    // a real contact sheet reads — every exposure the same rectangle. Portraits
    // are centre-cropped here and shown whole in the lightbox.
    <button
      className="frame"
      onClick={onOpen}
      aria-label={`Open frame ${frameNumber}, ${photo.basename}`}
    >
      {photo.ready ? (
        <img
          src={photo.urls.thumb}
          alt=""
          loading="lazy"
          decoding="async"
          className={loaded ? 'loaded' : ''}
          onLoad={() => setLoaded(true)}
        />
      ) : (
        <span className="frame-pending">DEVELOPING</span>
      )}

      <span className="frame-no">{frameNumber}</span>
      {showNegatives && photo.hasRaw && <span className="frame-raw">RAW</span>}
    </button>
  );
}

export function ContactSheet({ photos, showNegatives, onOpen }: Props) {
  return (
    <div className="sheet">
      {photos.map((photo, index) => (
        <Frame
          key={photo.photoId}
          photo={photo}
          index={index}
          showNegatives={showNegatives}
          onOpen={() => onOpen(index)}
        />
      ))}
    </div>
  );
}

/**
 * The film edge-marking header. Everything on the data line is read off the
 * photos themselves, so it describes the actual roll rather than restating the
 * folder name in smaller type.
 */
export function EdgeHeader({
  name,
  photos,
  extra,
}: {
  name: string;
  photos: PhotoView[];
  extra?: string;
}) {
  const dates = photos
    .map((p) => p.takenAt)
    .filter(Boolean)
    .sort();

  const format = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  const range =
    dates.length === 0
      ? null
      : format(dates[0]) === format(dates[dates.length - 1])
        ? format(dates[0])
        : `${format(dates[0])} — ${format(dates[dates.length - 1])}`;

  // A roll is usually one body; only name it when that is actually true.
  const cameras = [...new Set(photos.map((p) => p.camera).filter(Boolean))];
  const rawCount = photos.filter((p) => p.hasRaw).length;

  return (
    <header className="edge">
      <h1 className="edge-name">{name}</h1>
      <div className="edge-data">
        <span>
          {photos.length} {photos.length === 1 ? 'frame' : 'frames'}
        </span>
        {range && <span>{range}</span>}
        {cameras.length === 1 && <span>{cameras[0]}</span>}
        {rawCount > 0 && <span>{rawCount} raw</span>}
        {extra && <span>{extra}</span>}
      </div>
    </header>
  );
}
