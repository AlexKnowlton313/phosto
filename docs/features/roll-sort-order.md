# Roll order: frame 01 should be the first frame

## What is missing

Every sheet in the app sorts newest-first. `byTakenAtDesc` is applied in
`asAdmin` and again in `openShare`, and `ContactSheet` numbers frames from the
top: `String(index + 1).padStart(2, '0')`.

So on a roll shot over one afternoon, **frame 01 is the last exposure and the
highest number is the first**. On a real roll it is the other way round — frame
numbers are printed as the film advances, which is the whole reference the
design direction is built on ("uniform 3:2 cells, frame numbers, a folder header
set like film edge-printing").

Newest-first is right for *All photos*, which is an inbox. It is wrong for a
curated roll, and it is most wrong on a share link, where the roll is a sequence
somebody is meant to read from the beginning.

## The lazy design

One optional field on `Folder`:

```ts
sortOrder?: 'newest' | 'oldest';   // default 'newest'
```

- `PATCH /api/folders/<id>` already exists and already whitelists which fields
  it will write (`db.updateFolder` takes `Pick<Folder, 'name' | 'coverPhotoId'>`)
  — add the third key there and in the route's patch call.
- `byTakenAtDesc` gains a sibling, or a direction argument; `asAdmin` and
  `openShare` pass the folder's value. `openShare` already has the folder in
  hand for `folder.name`.
- The toggle lives in the roll toolbar next to *Share roll*, two words:
  `Oldest first` / `Newest first`. Not in a settings panel — there is no
  settings panel, and one field does not justify inventing one.

**All photos keeps sorting newest-first unconditionally.** It is not a folder,
it has no record to hold the field, and an inbox reads newest-first. The
`isLibrary` flag already gates exactly this class of thing.

Membership sort keys are untouched. They key on `uploadedAt` because derive
rewrites `takenAt` and a sort key cannot be updated in place; callers already
sort by `takenAt` after reading, so the direction is a property of that sort and
nothing in DynamoDB moves.

## What it changes downstream, for free

Frame numbers become meaningful on an ordered roll: 01 is the first exposure.
The `EdgeHeader` date range already reads "17 Jun 2025 to 21 Jun 2025" in
ascending order regardless, so the header and the sheet stop disagreeing.

## Cost

One optional attribute on ~10 folder items. Nothing measurable.

## Skipped

**Manual drag-to-reorder.** It is the feature people ask for and it is an order
of magnitude more work here: position would have to live on the *membership*
(a photo is in several rolls and can be ordered differently in each), the
membership's `gsi1sk` cannot be updated in place, so it means a separate
`position` attribute, a client-side sort on it, and a re-numbering write per
frame on every drag. Add it when a roll actually needs an order that capture
time cannot express — and note that for the common case, "these six go first",
making a second roll is already free.
