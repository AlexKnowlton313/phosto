import type { PhotoView } from '../api';
import { filtersActive, NO_FILTERS, type Filters } from './filters';

interface Props {
  /** The unfiltered sheet: the camera list and the "of N" count come off this. */
  photos: PhotoView[];
  value: Filters;
  onChange: (filters: Filters) => void;
  /** Absent until the memberships call lands — *Unfiled* waits for it. */
  memberships?: Record<string, string[]>;
  shown: number;
}

/**
 * The filter row, on All photos only. A roll needs none of this: *Unfiled* is
 * meaningless inside one, and a roll is already the narrowing.
 */
export function SheetFilters({ photos, value, onChange, memberships, shown }: Props) {
  // A roll shot on one body has nothing to choose between — same test the edge
  // header uses to decide whether naming the camera says anything.
  const cameras = [...new Set(photos.flatMap((p) => p.camera ?? []))].sort();

  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });

  return (
    <div className="filters">
      <input
        type="text"
        placeholder="Filename"
        aria-label="Filter by filename"
        value={value.text}
        onChange={(event) => set({ text: event.target.value })}
      />

      {cameras.length > 1 && (
        <select
          aria-label="Filter by camera"
          value={value.camera}
          onChange={(event) => set({ camera: event.target.value })}
        >
          <option value="">Any camera</option>
          {cameras.map((camera) => (
            <option key={camera} value={camera}>
              {camera}
            </option>
          ))}
        </select>
      )}

      <input
        type="month"
        aria-label="Filter by month taken"
        value={value.month}
        onChange={(event) => set({ month: event.target.value })}
      />

      <label className="check">
        <input
          type="checkbox"
          checked={value.hasRaw}
          onChange={(event) => set({ hasRaw: event.target.checked })}
        />
        Has RAW
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={value.undeveloped}
          onChange={(event) => set({ undeveloped: event.target.checked })}
        />
        Undeveloped
      </label>

      {/* Disabled rather than optimistic: with no memberships loaded every frame
          looks unfiled, which would flash the whole library as the answer. */}
      <label className="check">
        <input
          type="checkbox"
          disabled={!memberships}
          checked={value.unfiled}
          onChange={(event) => set({ unfiled: event.target.checked })}
        />
        In no roll
      </label>

      <div className="spacer" />

      {filtersActive(value) && (
        <>
          <span className="note">
            {shown} of {photos.length}
          </span>
          <button type="button" className="btn" onClick={() => onChange(NO_FILTERS)}>
            Clear filters
          </button>
        </>
      )}
    </div>
  );
}
