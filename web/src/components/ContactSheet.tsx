import { useState } from 'react';
import type { PhotoView } from '../api';

interface Props {
  photos: PhotoView[];
  selected: Set<string>;
  onOpen: (index: number) => void;
  /** `order` is the sheet's photoIds, passed only on a shift-click range. */
  onToggle: (photoId: string, order?: string[]) => void;
}

/**
 * How long a frame may sit undeveloped before the label stops claiming it is
 * working on it. Matches `RollView`'s poll ceiling, so the sheet gives up
 * looking and starts saying STUCK at the same moment.
 */
const STUCK_AFTER_MS = 2 * 60_000;

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
  onToggle: (shift: boolean) => void;
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
        type="button"
        className={`frame${selected ? ' frame-selected' : ''}`}
        // Shift-click ranges only once the mode is on — outside it this button
        // opens the lightbox, and the checkmark is still the only way in.
        onClick={(e) => (selecting ? onToggle(e.shiftKey) : onOpen())}
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
          <span className="frame-pending">
            {Date.now() - Date.parse(photo.uploadedAt) > STUCK_AFTER_MS
              ? 'STUCK'
              : 'DEVELOPING'}
          </span>
        )}

        <span className="frame-no">{frameNumber}</span>
      </button>

      {/* A sibling rather than a child: the frame is already a button and one
          cannot nest another, and this is the only way *into* selection mode. */}
      <button
        type="button"
        className="frame-check"
        onClick={(e) => onToggle(e.shiftKey)}
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
            onToggle={(shift) =>
              // The order is built per shift-click rather than held: the sheet
              // re-renders on every selection change, and this costs one pass
              // over an array that is already in hand.
              onToggle(photo.photoId, shift ? photos.map((p) => p.photoId) : undefined)
            }
          />
        ))}
      </div>
    </>
  );
}

/**
 * Placeholder sheet while the photos are in flight. Cells surface one after the
 * other the way prints come up in a tray, and they carry frame numbers, so the
 * wait reads as a contact sheet developing rather than a generic shimmer. The
 * count is a guess — twelve fills a laptop viewport without pushing a long scroll
 * onto a phone, and the real sheet replaces it whole.
 */
export function SkeletonSheet() {
  return (
    <div className="sheet" aria-busy="true" aria-label="Developing frames">
      {Array.from({ length: 12 }, (_, index) => (
        <div
          key={index}
          className="frame frame-skeleton"
          style={{ animationDelay: `${index * 90}ms` }}
        >
          <span className="frame-no">{String(index + 1).padStart(2, '0')}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The sheet with nothing on it. Two different nothings, and telling them apart
 * is the point: a filter that excludes all 835 frames must not read as a library
 * that lost them.
 */
export function EmptySheet({
  isLibrary,
  isTrash,
  /** Frames exist — the filters are what is hiding them. */
  filtered,
  /** *In no roll* is the only filter on, so an empty result is good news. */
  unfiledOnly,
}: {
  isLibrary: boolean;
  isTrash: boolean;
  filtered: boolean;
  unfiledOnly: boolean;
}) {
  // An empty bin is the good state, and the only one of these three nothings
  // that is not waiting for the owner to do something about it.
  if (isTrash) {
    return (
      <div className="empty">
        <h2>The trash is empty</h2>
        <p className="note">
          Frames deleted from All photos wait here with their originals and RAWs
          intact, until you restore them or destroy them for good.
        </p>
      </div>
    );
  }

  return (
    <div className="empty">
      {filtered ? (
        <>
          <h2>No frames match</h2>
          <p className="note">
            {unfiledOnly
              ? 'Every frame in the library is in at least one roll.'
              : 'Nothing on this sheet fits the filters.'}
          </p>
        </>
      ) : (
        <>
          <h2>{isLibrary ? 'No photos yet' : 'Empty roll'}</h2>
          <p className="note">
            {isLibrary
              ? 'Add photos from the roll index. JPEGs and RAFs with matching ' +
                'filenames become one frame.'
              : 'Nothing here yet. Select frames in All photos and add them to this roll.'}
          </p>
        </>
      )}
    </div>
  );
}

const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

/**
 * The film edge-marking header. Everything on the data line is read off the
 * photos themselves, so it describes the actual roll rather than restating the
 * folder name in smaller type.
 */
export function EdgeHeader({
  name,
  photos,
  note,
  onRename,
  onEditNote,
}: {
  name: string;
  photos: PhotoView[];
  /** The roll's own line about itself, shown to the share viewer and to the
   * admin — the admin has to read what a link is about to say. */
  note?: string;
  /** Admin only, and absent on the All photos view, which is not a roll —
   * same pattern as Lightbox's onDelete. A share viewer never sees it. */
  onRename?: () => void;
  onEditNote?: () => void;
}) {
  // flatMap over map+filter: an undefined takenAt drops out as an empty slot
  // rather than surviving into the sort as a falsy string.
  const dates = photos.flatMap((p) => p.takenAt ?? []).sort();

  const range =
    dates.length === 0
      ? null
      : dayMonth(dates[0]) === dayMonth(dates[dates.length - 1])
        ? dayMonth(dates[0])
        : `${dayMonth(dates[0])} to ${dayMonth(dates[dates.length - 1])}`;

  // A roll is usually one body; only name it when that is actually true.
  const cameras = [...new Set(photos.flatMap((p) => p.camera ?? []))];
  const rawCount = photos.filter((p) => p.hasRaw).length;

  return (
    <header className="edge">
      <h1 className="edge-name">
        {name}
        {onRename && (
          <button type="button" className="edge-rename" onClick={onRename}>
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
      </div>
      {/* Under the data line, not over it: the frame count is what the header is
          for, and the note is the caption to it. Plain text, so the newlines the
          textarea allows are kept by CSS rather than by parsing anything. */}
      {note && <p className="edge-note">{note}</p>}
      {onEditNote && (
        <button type="button" className="edge-rename edge-note-edit" onClick={onEditNote}>
          {note ? 'Edit note' : 'Add a note'}
        </button>
      )}
    </header>
  );
}
