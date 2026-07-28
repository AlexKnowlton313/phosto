# Card dumps: batches over 200, duplicate detection, and filing on the spot

## What is missing

Three gaps in the one path that can create a photograph.

**1. The 200-file cap is a cliff, not a queue.** `createUploads` throws
`Batch limited to 200 files` and the admin UI does not chunk (`handleFiles` in
`RollIndex.tsx` sends `[...files]` in one call). A 512-frame card fails the
*whole* selection with a 400 and no partial progress. `CLAUDE.md` records this
as a known ceiling: "a card dump larger than that has to go in batches" —
meaning the human batches it, by hand, in the file picker.

**2. Nothing detects a re-import.** Every upload mints `randomUUID()`.
Basenames are grouped *within* a batch only, so dropping the same card twice
produces a second, complete set of photographs with different ids, the same
filenames, the same pixels, and no way to tell them apart in the grid. At ~43 MB
a frame that is real money and a real mess.

**3. The frames you just uploaded are immediately hard to find.** Upload lands
you on All photos, where the new frames are interleaved by capture date with
everything else. See `find-unfiled-frames.md` — but the upload flow can do
better than a filter, because it *already knows the ids*: `requestUploads`
returns `{ filename, url, photoId }` for every file.

## The lazy design

**Chunking, in the client.** `createUploads` stays as it is — the cap is a
sensible server guard. `handleFiles` slices the file list into groups of 200 and
calls `requestUploads` per slice, concatenating the results before the existing
4-worker upload loop runs. The one rule: **a basename pair must not straddle a
slice**, or `XT300024.JPG` and `XT300024.RAF` become two photographs instead of
one. Sort by filename before slicing and extend each slice to the end of its
basename group. ~15 lines, and the progress bar keeps working unchanged because
it counts objects, not requests.

**Duplicate warning, from data already loaded.** The admin has the whole library
in memory whenever All photos has been opened, and every `PhotoView` carries
`basename`. Before uploading, intersect the picked filenames' stems with the
known basenames and, if any match, `confirm()`:

> 187 of these 200 files have names already in the library. Upload anyway?

Not a refusal — re-importing on purpose is legitimate, and two different cards
genuinely can both hold `DSCF0001`. A basename match is a strong hint, not a
fact. It costs one `Set` and one dialog.

Doing this on the server instead would want an index on `basename`, which the
table does not have and does not need for anything else.

**File on the spot.** After the uploads finish, one dialog:

> 200 frames uploaded. Add them to a roll?  [New roll…] [Iceland] [Skip]

The photoIds are in hand; the picker is `choose()`, already built; attaching is
`api.attachPhotos(folderId, photoIds)`, already built and uncapped. This does
**not** reintroduce "which roll did this go to" — the frames are in the library
either way, and *Skip* is a first-class answer. It just removes the round trip
through All photos for the common case where you already know.

## Cost

Chunking: the same number of presigned PUTs, split across more API calls — three
Lambda invocations instead of one for a 512-file card. Nothing.

Duplicate check: zero, it is client-side over data already fetched.

The value is on the other side: one avoided accidental re-import of a 200-frame
card is ~8.6 GB, which is **$0.20/month forever** at Standard, or about 70% of
the entire current bill, for bytes nobody wants.

## Skipped

Content hashing to detect true duplicates (an ETag or a perceptual hash), and
server-side dedupe. Both need bytes or an index; a filename match catches the
realistic mistake — the same card mounted twice — and the confirm dialog covers
the rest. Add hashing when a duplicate gets through the name check in practice.
