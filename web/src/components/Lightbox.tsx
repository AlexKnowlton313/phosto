import { useEffect, useRef } from 'react';
import type { PhotoView } from '../api';
import { modalOpen } from './Dialog';

type View = { scale: number; x: number; y: number };

const UNZOOMED: View = { scale: 1, x: 0, y: 0 };

/**
 * Zoom lives in a ref and is written straight to the img, not held in state.
 *
 * Clamping a pan means measuring the element being transformed, so as a state
 * updater this was not a function of its argument at all — it read the DOM, and
 * an updater React may call more than once, whenever it likes, has to be pure.
 * Nothing renders off the zoom either, so it was never data: it is a paint, and
 * as one it also stops a wheel gesture re-rendering the frame at 60Hz.
 */
const paint = (img: HTMLImageElement | null, v: View) => {
  if (!img) return;
  img.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  img.style.cursor = v.scale > 1 ? 'grab' : '';
};

interface Props {
  photos: PhotoView[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onDownload: (photo: PhotoView, kind: 'original' | 'raw') => void;
  /** Only supplied in the admin view; viewers never see a delete control. */
  onDelete?: (photo: PhotoView) => void;
  /** Admin only, same as onDelete. Absent in the library, which is not a roll. */
  onSetCover?: (photo: PhotoView) => void;
  /** Admin only. Offered on an undeveloped frame — a viewer never sees one. */
  onDevelop?: (photo: PhotoView) => void;
  /**
   * The rolls this frame is in, by name. Admin All-photos only: a share viewer
   * has no rolls, and inside a roll the answer is the roll you are already in.
   * Absent means "don't say"; an empty array means "in no roll", which is the
   * whole reason this is here.
   */
  rollsOf?: (photo: PhotoView) => string[];
}

export function Lightbox({
  photos,
  index,
  onClose,
  onNavigate,
  onDownload,
  onDelete,
  onSetCover,
  onDevelop,
  rollsOf,
}: Props) {
  const photo = photos[index];
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  /** Current zoom, as a transform on the img: `translate(x, y) scale(scale)`. */
  const view = useRef<View>(UNZOOMED);

  // A new frame arrives in the same <img>, so the transform outlives its
  // subject unless it is cleared here.
  useEffect(() => {
    view.current = UNZOOMED;
    paint(stage.current?.querySelector('img') ?? null, UNZOOMED);
  }, [index]);

  // Native modal: the top layer is what puts this over the sheet without a
  // z-index argument, and Esc closing it comes from the platform.
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Esc and a backdrop click both close the element without telling React, so
  // the state that mounted it has to follow the DOM back down.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const closed = () => onClose();
    el.addEventListener('close', closed);
    return () => el.removeEventListener('close', closed);
  }, [onClose]);

  // The overlay covers the sheet but does not stop it scrolling underneath.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Wheel on desktop, pinch on touch. The transform is on the img, so the
  // fit-to-stage sizing in styles.css stays the 1x state and zooming out always
  // lands back on it exactly — no re-derived "fit" scale to drift from it.
  useEffect(() => {
    const node = stage.current;
    if (!node) return;

    // Keep the frame covering the stage: pan no further than the overhang the
    // zoom actually created, and centre whichever axis has none. offsetWidth is
    // the layout size, unlike getBoundingClientRect, which already has the
    // transform we are computing baked in.
    const contain = (v: View): View => {
      const img = node.querySelector('img');
      if (!img) return v;
      const limitX = Math.max(0, (img.offsetWidth * v.scale - node.clientWidth) / 2);
      const limitY = Math.max(0, (img.offsetHeight * v.scale - node.clientHeight) / 2);
      return {
        scale: v.scale,
        x: Math.min(Math.max(v.x, -limitX), limitX),
        y: Math.min(Math.max(v.y, -limitY), limitY),
      };
    };

    const show = (next: View) => {
      view.current = next;
      paint(node.querySelector('img'), next);
    };

    // Zoom about a screen point, keeping whatever is under it under it: with
    // `translate(x) scale(s)` about the centre, a content point sits at
    // p = x + s·c, so holding p fixed across s → s·k gives x' = p − k(p − x).
    const zoomAbout = (factor: number, clientX: number, clientY: number) => {
      const v = view.current;
      const scale = Math.min(Math.max(v.scale * factor, 1), 6);
      if (scale === 1) return show(UNZOOMED);
      const k = scale / v.scale;
      const box = node.getBoundingClientRect();
      const px = clientX - box.left - box.width / 2;
      const py = clientY - box.top - box.height / 2;
      show(contain({ scale, x: px - k * (px - v.x), y: py - k * (py - v.y) }));
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAbout(Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    };

    const points = new Map<number, { x: number; y: number }>();
    let spread = 0;
    const spreadOf = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);

    const onDown = (event: PointerEvent) => {
      // Leave the nav and bar buttons their own gestures.
      if ((event.target as HTMLElement).closest('button')) return;
      node.setPointerCapture(event.pointerId);
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [a, b] = [...points.values()];
      if (b) spread = spreadOf(a, b);
    };

    const onMove = (event: PointerEvent) => {
      const previous = points.get(event.pointerId);
      if (!previous) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [a, b] = [...points.values()];

      if (b) {
        const next = spreadOf(a, b);
        if (spread > 0) zoomAbout(next / spread, (a.x + b.x) / 2, (a.y + b.y) / 2);
        spread = next;
      } else if (view.current.scale > 1) {
        const v = view.current;
        show(
          contain({
            ...v,
            x: v.x + event.clientX - previous.x,
            y: v.y + event.clientY - previous.y,
          }),
        );
      }
    };

    const onUp = (event: PointerEvent) => {
      points.delete(event.pointerId);
      spread = 0;
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
    };
  }, []);

  // Move focus into the dialog on open and hand it back to the grid on close,
  // so keyboard and screen-reader users are not left behind the overlay.
  // Only if the frame was keyboard-focused to begin with: a programmatic
  // .focus() matches :focus-visible, so restoring it to a frame the user merely
  // clicked leaves the amber ring painted on the cell after the lightbox closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const restore = previous?.matches(':focus-visible') ?? false;
    dialog.current?.focus();
    return () => {
      if (restore) previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A confirm dialog opened from here owns the keyboard until it is answered.
      // Escape is not here: the dialog element cancels itself, and the `close`
      // listener above is what tells React about it.
      if (modalOpen()) return;
      if (event.key === 'ArrowRight') onNavigate(Math.min(index + 1, photos.length - 1));
      if (event.key === 'ArrowLeft') onNavigate(Math.max(index - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, photos.length, onNavigate]);

  // Warm the neighbours so arrowing through the roll does not flash empty.
  useEffect(() => {
    for (const neighbour of [photos[index - 1], photos[index + 1]]) {
      if (neighbour?.ready) new Image().src = neighbour.urls.large;
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

  const rolls = rollsOf?.(photo);

  return (
    <dialog className="lightbox" aria-label={photo.basename} ref={dialog} tabIndex={-1}>
      <div className="lightbox-stage" ref={stage}>
        <img
          src={photo.urls.large}
          alt={photo.basename}
          /* A mouse drag on an img starts native drag-and-drop, which cancels
             the pointer stream a few pixels in and kills panning. */
          draggable={false}
        />

        {index > 0 && (
          <button
            type="button"
            className="lightbox-nav prev"
            onClick={() => onNavigate(index - 1)}
            aria-label="Previous frame"
          >
            ‹
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            type="button"
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
          {/* Plain --muted, not amber: amber is negatives and nothing else, and
              being unfiled is a fact about the frame, not a warning. */}
          {rolls && (
            <div className="exif">
              <span>{rolls.length > 0 ? `In ${rolls.join(' · ')}` : 'In no roll'}</span>
            </div>
          )}
        </div>

        <div className="spacer" />

        {photo.canDownload && (
          <button type="button" className="btn" onClick={() => onDownload(photo, 'original')}>
            Download JPEG
          </button>
        )}
        {/* The API zeroes hasRaw on a share, so only the owner ever sees this. */}
        {photo.hasRaw && (
          <button
            type="button"
            className="btn btn-negatives"
            onClick={() => onDownload(photo, 'raw')}
          >
            Download RAW
          </button>
        )}
        {/* Nothing to look at on an undeveloped frame — this is the one thing
            worth offering on it. */}
        {onDevelop && !photo.ready && (
          <button type="button" className="btn" onClick={() => onDevelop(photo)}>
            Develop again
          </button>
        )}
        {/* A photo with no derivative has no thumb.webp to use as a cover. */}
        {onSetCover && photo.ready && (
          <button type="button" className="btn" onClick={() => onSetCover(photo)}>
            Set as cover
          </button>
        )}
        {onDelete && (
          <button type="button" className="btn btn-danger" onClick={() => onDelete(photo)}>
            Delete
          </button>
        )}
        {/* close() rather than onClose(), so every way out of here — button,
            Esc, backdrop — leaves through the same `close` event. */}
        <button type="button" className="btn" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
