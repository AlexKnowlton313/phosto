# Range select, select all, and "New roll…" in the picker

## What is missing

Selection is one click per frame. `useSelection` exposes `toggle`, `clear`,
`retain` and nothing else (`web/src/components/selection.ts`), and `ContactSheet`
calls `onToggle(photo.photoId)` per cell. There is no shift-click range, no
select-all, and no way to invert.

Filing a card dump is therefore 200 clicks, and the *only* way a frame gets into
a roll is `PUT /api/folders/<id>/photos` driven by that selection — so this is
the bottleneck on the one workflow the app is built around.

The picker in `addToRoll` (`web/src/components/SelectionBar.tsx:113`) lists
existing rolls only. Filing an import into a *new* roll means: leave the sheet,
roll index, New roll, back into All photos, re-select, add.

## Why it matters here

Attach and detach carry **no batch cap** — one transaction each, no S3 work
(`CLAUDE.md`, "Data model"). The server is already built to take the whole
library in one call. The UI is what cannot express it.

## The lazy design

1. **Shift-click range.** `useSelection` keeps one more ref: the index of the
   last frame toggled. `toggle(photoId, index, shiftKey)` — when `shiftKey` and
   an anchor exist, add every photoId between anchor and index in sheet order.
   The sheet already renders in order and already passes `index` to `Frame`, so
   nothing new has to be threaded. ~15 lines.

2. **Select all / none.** One button in the roll toolbar (`RollView`'s
   `.toolbar`, beside *All rolls*), not in `SelectionBar` — the bar only exists
   once something is selected, so it cannot be the way *in*. `setSelected(new
   Set(photos.map(p => p.photoId)))`. Two lines plus a button.

3. **"New roll…" as the first option in the picker.** `choose()` already
   returns an option id; add a sentinel option, and when it comes back call the
   existing `prompt()` for a name, `api.createFolder(name)`, then attach to the
   id it returns. Reuses three functions that already exist. ~10 lines in
   `addToRoll`.

Nothing on the server changes.

## Interaction notes

- Shift-click must not fight the "first selection is the mode" rule: outside
  selection mode the frame button opens the lightbox. Keep that — shift-click
  the checkmark, or hold shift on a frame *while already selecting*.
- Select-all on **All photos** at 835 frames puts 835 ids in a Set and renders
  835 `frame-selected` cells. That is one React commit, not 835; it is fine.
  Delete of that selection is not — see `trash.md`.

## Cost

Zero. No API calls, no new routes, no bytes.

## Skipped

Rubber-band/drag selection, and keyboard `j`/`k` navigation over the sheet. Add
when shift-click has been in use long enough to prove it is still slow.
