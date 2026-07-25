import { useEffect, useRef } from 'react';
import type { PhotoView } from '../api';

interface Props {
  photos: PhotoView[];
  index: number;
  showNegatives: boolean;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onDownload: (photo: PhotoView, kind: 'original' | 'raw') => void;
  /** Only supplied in the admin view; viewers never see a delete control. */
  onDelete?: (photo: PhotoView) => void;
}

export function Lightbox({
  photos,
  index,
  showNegatives,
  onClose,
  onNavigate,
  onDownload,
  onDelete,
}: Props) {
  const photo = photos[index];
  const dialog = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on open and hand it back to the grid on close,
  // so keyboard and screen-reader users are not left behind the overlay.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') onNavigate(Math.min(index + 1, photos.length - 1));
      if (event.key === 'ArrowLeft') onNavigate(Math.max(index - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, photos.length, onClose, onNavigate]);

  // Warm the neighbours so arrowing through the roll does not flash empty.
  useEffect(() => {
    for (const neighbour of [photos[index - 1], photos[index + 1]]) {
      if (neighbour?.ready) new Image().src = neighbour.urls.medium;
    }
  }, [index, photos]);

  if (!photo) return null;

  const exif = [
    photo.camera,
    photo.lens,
    photo.focalLength,
    photo.aperture,
    photo.shutter,
    photo.iso ? `ISO ${photo.iso}` : undefined,
  ].filter(Boolean) as string[];

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={photo.basename}
      ref={dialog}
      tabIndex={-1}
    >
      <div className="lightbox-stage">
        <img src={photo.urls.large} alt={photo.basename} />

        {index > 0 && (
          <button
            className="lightbox-nav prev"
            onClick={() => onNavigate(index - 1)}
            aria-label="Previous frame"
          >
            ‹
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            className="lightbox-nav next"
            onClick={() => onNavigate(index + 1)}
            aria-label="Next frame"
          >
            ›
          </button>
        )}
      </div>

      <div className="lightbox-bar">
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
            {String(index + 1).padStart(2, '0')} · {photo.basename}
          </div>
          {exif.length > 0 && (
            <div className="exif">
              {exif.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
        </div>

        <div className="spacer" />

        {photo.canDownload && (
          <button className="btn" onClick={() => onDownload(photo, 'original')}>
            Download JPEG
          </button>
        )}
        {showNegatives && photo.hasRaw && (
          <button className="btn btn-negatives" onClick={() => onDownload(photo, 'raw')}>
            Download RAW
          </button>
        )}
        {onDelete && (
          <button className="btn btn-danger" onClick={() => onDelete(photo)}>
            Delete
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
