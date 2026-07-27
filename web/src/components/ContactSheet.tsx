import { useCallback, useEffect, useState } from 'react';
import type { PhotoView } from '../api';

interface Props {
  photos: PhotoView[];
  selected: Set<string>;
  onOpen: (index: number) => void;
  onToggle: (photoId: string) => void;
}

/**
 * Frame selection, keyed by photoId. The first selection *is* the mode — there is
 * no toolbar switch — so both views need the same escape hatch back out of it.
 */
export function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((photoId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(photoId)) next.add(photoId);
      return next;
    });
  }, []);

  // Returning `prev` when already empty matters: this fires on every Escape in
  // the app, including the one that closes the lightbox, and a fresh Set there
  // would re-render the whole sheet for nothing.
  const clear = useCallback(
    () => setSelected((prev) => (prev.size ? new Set() : prev)),
    [],
  );

  /** Drops ids that are no longer on the sheet, e.g. after a photo is deleted. */
  const retain = useCallback((photoIds: string[]) => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => photoIds.includes(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  return { selected, toggle, clear, retain };
}

/**
 * The selected photos a batch download can actually fetch, in sheet order. A
 * RAW-only frame has no `orig/` object and so no `canDownload`; both views gate
 * their buttons on this being non-empty so neither offers a no-op.
 */
export const selectable = (
  photos: PhotoView[],
  selected: Set<string>,
  kind: 'original' | 'raw',
) =>
  photos.filter(
    (p) => selected.has(p.photoId) && (kind === 'raw' ? p.hasRaw : p.canDownload),
  );

function Frame({
  photo,
  index,
  selected,
  selecting,
  onOpen,
  onToggle,
}: {
  photo: PhotoView;
  index: number;
  selected: boolean;
  selecting: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  // Frame numbers run in shooting order, one-based, the way they do on a roll.
  const frameNumber = String(index + 1).padStart(2, '0');

  return (
    // Cells stay a uniform 3:2 regardless of the frame's own aspect, which is how
    // a real contact sheet reads — every exposure the same rectangle. Portraits
    // are centre-cropped here and shown whole in the lightbox.
    <div className="cell">
      <button
        className={`frame${selected ? ' frame-selected' : ''}`}
        onClick={selecting ? onToggle : onOpen}
        // Only a toggle while the mode is on; outside it this button opens a
        // dialog and announcing it as pressable would be a lie.
        aria-pressed={selecting ? selected : undefined}
        aria-label={`${selecting ? 'Select' : 'Open'} frame ${frameNumber}, ${photo.basename}`}
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
      </button>

      {/* A sibling rather than a child: the frame is already a button and one
          cannot nest another, and this is the only way *into* selection mode. */}
      <button
        className="frame-check"
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={`Select frame ${frameNumber}`}
      >
        ✓
      </button>
    </div>
  );
}

export function ContactSheet({ photos, selected, onOpen, onToggle }: Props) {
  return (
    <>
      {/* Here rather than in either toolbar: a live region has to be in the DOM
          before its text changes, and both toolbars arrive with the selection. */}
      <p className="sr-only" aria-live="polite">
        {selected.size > 0 ? `${selected.size} selected` : ''}
      </p>

      <div className="sheet">
        {photos.map((photo, index) => (
          <Frame
            key={photo.photoId}
            photo={photo}
            index={index}
            selected={selected.has(photo.photoId)}
            selecting={selected.size > 0}
            onOpen={() => onOpen(index)}
            onToggle={() => onToggle(photo.photoId)}
          />
        ))}
      </div>
    </>
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
  onRename,
}: {
  name: string;
  photos: PhotoView[];
  extra?: string;
  /** Admin only, and absent on the All photos view, which is not a roll —
   * same pattern as Lightbox's onDelete. A share viewer never sees it. */
  onRename?: () => void;
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
        : `${format(dates[0])} to ${format(dates[dates.length - 1])}`;

  // A roll is usually one body; only name it when that is actually true.
  const cameras = [...new Set(photos.map((p) => p.camera).filter(Boolean))];
  const rawCount = photos.filter((p) => p.hasRaw).length;

  return (
    <header className="edge">
      <h1 className="edge-name">
        {name}
        {onRename && (
          <button className="edge-rename" onClick={onRename}>
            Rename
          </button>
        )}
      </h1>
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
