import { useCallback, useEffect, useRef, useState } from 'react';
import type { PhotoView } from '../api';
import { modalOpen } from './Dialog';

/**
 * Frame selection, keyed by photoId. The first selection *is* the mode — there is
 * no toolbar switch — so both views need the same escape hatch back out of it.
 *
 * Here rather than beside the sheet that renders it: a module that exports a
 * component should export only components, or fast refresh stops swapping it in.
 */
export function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The last frame toggled, as the far end of a shift-click range.
  const anchor = useRef<string>();

  /**
   * Toggles one frame — or, given `order`, selects everything between the last
   * frame toggled and this one.
   *
   * `order` is the sheet's photoIds and arrives only on a shift-click, so the
   * hook never has to know what is on the sheet, and building it costs nothing
   * on an ordinary click.
   */
  const toggle = useCallback((photoId: string, order: string[] = []) => {
    const from = anchor.current ? order.indexOf(anchor.current) : -1;
    const to = order.indexOf(photoId);
    anchor.current = photoId;

    setSelected((prev) => {
      const next = new Set(prev);
      // A range only ever adds. The anchor is wherever the last click landed, so
      // a range that could also deselect would make one gesture mean two things
      // depending on a state the sheet does not show.
      if (from >= 0 && to >= 0) {
        for (const id of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          next.add(id);
        }
      } else if (!next.delete(photoId)) {
        next.add(photoId);
      }
      return next;
    });
  }, []);

  // Returning `prev` when already empty matters: this fires on every Escape in
  // the app, including the one that closes the lightbox, and a fresh Set there
  // would re-render the whole sheet for nothing.
  const clear = useCallback(() => {
    // Dropping the anchor too, or the next shift-click ranges back to a frame
    // selected before the selection was thrown away.
    anchor.current = undefined;
    setSelected((prev) => (prev.size ? new Set() : prev));
  }, []);

  /** Drops ids that are no longer on the sheet, e.g. after a photo is deleted. */
  const retain = useCallback((photoIds: string[]) => {
    setSelected((prev) => {
      // A Set, not `photoIds.includes`: this runs against the whole library.
      const alive = new Set(photoIds);
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape belongs to an open dialog — cancelling one must not also drop the
      // selection it was asking about.
      if (event.key === 'Escape' && !modalOpen()) clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  return { selected, setSelected, toggle, clear, retain };
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
