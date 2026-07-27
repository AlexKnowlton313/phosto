import { useCallback, useEffect, useState } from 'react';
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
