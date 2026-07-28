# Bulk download for share viewers: progress, and not stopping at the first failure

## What is missing

*Download JPEGs* on a share loops the selection one frame at a time
(`Share.tsx`), signing each URL just before its download and pausing 150 ms
between them because browsers drop a burst of programmatic downloads. That part
is correct, and both copies of the loop carry the comment explaining why they
are sequential rather than concurrent.

What is missing is everything around it:

- **No progress.** Forty frames is ~11 seconds of a disabled button with no
  indication anything is happening. The admin's `SelectionBar` has the same
  gap; only `destroySelected` reports "Deleted 3 of 40…".
- **It stops at the first failure**, deliberately — the comment says these fail
  as a group, an expired link refuses every remaining frame too. True for an
  expired link. Not true for a transient 500 on frame 12, which currently
  abandons frames 13 through 40 and reports one message.
- **No record of what actually landed.** The selection is left intact, so the
  user has to work out which files are in their Downloads folder and re-pick the
  rest by hand.

## The lazy design

All of it lives in the loop that already exists, in both `Share.tsx` and
`SelectionBar.tsx` — the same handful of lines twice, which is an argument for
lifting it into one helper beside `saveAs` in `web/src/api.ts`:

```ts
// Sequential with a fixed 150ms gap: browsers silently drop a burst of
// programmatic downloads, which is why this is a loop and not Promise.all.
// Continues past a single failure; a run that fails wholesale reports every
// frame, which reads the same as stopping did.
async function downloadEach(photos, sign, onProgress) { … }
```

1. **Progress**, into the status line both views already render:
   `Downloading 12 of 40…`. The admin has `setStatus` for exactly this; the
   share view needs one `useState`.
2. **Continue on failure**, collecting `{ photoId, message }` the way
   `setMembership` already collects `failed` on the server. At the end, one
   summary: `Downloaded 38 of 40 — DSCF1201, DSCF1244 failed`. The pattern and
   the phrasing already exist in `membershipNote`.
3. **Keep the failures selected**, clear the rest. `useSelection` already has
   `retain(photoIds)` for precisely this shape of "narrow the selection to
   these", built for post-delete cleanup. Pressing the button again retries
   exactly what did not land.

## What about a zip?

The obvious request is one file. It does not fit this system, and the numbers
are why:

- **Server-side zip**: needs a Lambda that reads every original — 40 × 14.5 MB =
  580 MB through a function with a 15-second timeout and a 6 MB response cap. It
  would have to stream to S3 and hand back a signed URL, which means a new
  object, a lifecycle rule to clean it up, and compute in a path the whole
  architecture exists to keep compute out of. The design note is explicit: "there
  is no compute in the image path — CloudFront serves derivatives straight from
  S3, which is what makes this cost $0.29/month."
- **Client-side zip**: a JS zip library plus 580 MB held in browser memory,
  which is a tab crash on a phone. `showDirectoryPicker()` streams to disk
  instead and avoids the memory problem entirely — but it is Chromium-only, so
  it is a second code path that most viewers never take.

N files with honest progress is the right answer at this scale. Revisit if a
share ever needs to hand over hundreds of originals, and revisit it as
`showDirectoryPicker()` with the existing loop as the fallback — not as a zip.

## Cost

Zero. Same signed URLs, same number of `GET`s, same egress. Continuing past a
failure can cost a few more `POST /api/share/<token>/photos/<id>/original`
calls than stopping did — Lambda invocations, of which the free tier has a
million.

## Skipped

Zip in any form (above). Resumable downloads. A per-file progress bar — the
files are 14 MB and land in a second or two each; the count is the useful number.
