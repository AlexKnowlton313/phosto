import type { FolderView, PhotoView } from '../api';

/**
 * What the All-photos sheet is narrowed by. Every field is falsy when unset,
 * which is what lets `filtersActive` be one `Object.values` and *Clear filters*
 * be one assignment.
 *
 * Split from `SheetFilters.tsx` for the same reason `selection.ts` is split from
 * the bar that uses it: a module exporting both a component and plain values
 * costs Fast Refresh the ability to preserve state across an edit.
 */
export interface Filters {
  text: string;
  camera: string;
  /** `YYYY-MM`, straight off `<input type="month">`. */
  month: string;
  hasRaw: boolean;
  undeveloped: boolean;
  unfiled: boolean;
}

export const NO_FILTERS: Filters = {
  text: '',
  camera: '',
  month: '',
  hasRaw: false,
  undeveloped: false,
  unfiled: false,
};

export const filtersActive = (filters: Filters) => Object.values(filters).some(Boolean);

/**
 * Narrows the sheet. Everything except *unfiled* reads fields the library
 * payload already carries, so this is a pass over data already in memory — no
 * route, no query, no bytes. `memberships` is the one thing that had to be
 * fetched, and the toggle needing it stays disabled until it lands, so an
 * absent map here never silently reports the whole library as unfiled.
 */
export function filterPhotos(
  photos: PhotoView[],
  filters: Filters,
  memberships?: Record<string, string[]>,
): PhotoView[] {
  const text = filters.text.trim().toLowerCase();

  return photos.filter(
    (photo) =>
      (!text || photo.basename.toLowerCase().includes(text)) &&
      (!filters.camera || photo.camera === filters.camera) &&
      // The month of the stored timestamp, which is how takenAt is compared
      // everywhere else here. The edge header renders it as a *local* date, so
      // a frame shot near midnight can print one month and match the other.
      (!filters.month || (photo.takenAt ?? '').startsWith(filters.month)) &&
      (!filters.hasRaw || photo.hasRaw) &&
      (!filters.undeveloped || !photo.ready) &&
      (!filters.unfiled || !memberships?.[photo.photoId]?.length),
  );
}

/**
 * The rolls one frame is in, by name. A folder id with no matching roll falls
 * back to the id rather than vanishing — the roll list and the memberships are
 * two reads and can disagree for a moment after a delete.
 */
export const rollNames = (
  memberships: Record<string, string[]>,
  folders: FolderView[] | undefined,
  photoId: string,
) =>
  (memberships[photoId] ?? []).map(
    (id) => folders?.find((f) => f.folderId === id)?.name ?? id,
  );
