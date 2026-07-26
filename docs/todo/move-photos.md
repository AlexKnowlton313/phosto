# Moving a photo between folders

The only feature here that needs real backend work, and the only one that can
damage the library if the steps run in the wrong order.

## What exists

Nothing. There is no route, no `db` function, and no UI. Deleting a photo exists
and works (`deletePhotoAndObjects`, `functions/api/index.ts:229`); moving does not.

## Why the folder cannot just be relabelled

The obvious cheap version — change `folderId` on the DynamoDB item and leave the S3
objects where they are — is wrong, and wrong in a way that quietly breaks access
control rather than throwing.

A share cookie is signed for the resource `https://<domain>/f/<folderId>/*`
(`functions/shared/keys.ts:20`). The key path *is* the authorization boundary; that
is the whole reason the three prefixes exist. A photo whose record says folder B
while its bytes still live under `f/<A>/…` would be invisible to anyone holding a
share for B, and would remain readable by anyone holding a stale share for A. The
API would look correct while the enforcement layer disagreed with it.

So a move is a physical move: every object for that photo has to be copied to keys
under the new `folderId` and the old ones deleted.

## Objects to move

For one photo, up to four objects:

```
f/<src>/<photoId>/thumb.webp     f/<dst>/<photoId>/thumb.webp
f/<src>/<photoId>/large.webp     f/<dst>/<photoId>/large.webp
orig/<src>/<photoId>.<ext>       orig/<dst>/<photoId>.<ext>
raw/<src>/<photoId>.<ext>        raw/<dst>/<photoId>.<ext>
```

`photoId` does not change, so nothing else in the record needs rewriting.

## The lazy path: let the derive Lambda rebuild the derivatives

The derive function fires on `OBJECT_CREATED` under `orig/` and `raw/`
(`infra/lib/phosto-stack.ts:233-243`). Copying the original into the destination
prefix therefore *retriggers derivation at the new key* — which is exactly the
output wanted. Do not copy `f/*` by hand; let the copy of `orig/` regenerate it.

This makes the ordering load-bearing:

1. **Move the DynamoDB record first.** The derive handler looks the photo up with
   `findPhoto(folderId, photoId)` and drops the event if there is no record
   (`functions/derive/index.ts:98`). If the S3 copy lands before the record moves,
   the event is discarded and the photo arrives in the new folder with no
   derivatives and no retry.
2. **Copy `orig/` and then `raw/`.** Derive runs on the `orig/` copy and writes
   `f/<dst>/<photoId>/*`. The `raw/` copy fires a second event that returns
   immediately for paired photos — `if (isRaw && photo.originalExt) return`
   (`functions/derive/index.ts:106`) — so it costs one warm invocation and nothing
   else. For a RAW-only photo the RAF path runs and extracts the preview again.
3. **Delete the old objects** — all four old keys, including both derivatives.

Between steps 1 and 2 the photo appears in the destination folder as `DEVELOPING`.
The admin view already polls every 4 seconds while any photo is not `ready`
(`web/src/views/Admin.tsx:67`), so it fills itself in with no extra work.

The cost is one re-decode per moved photo. At 2048 MB for a couple of seconds that
is a fraction of a cent for a whole roll, and it buys away an entire class of
partial-copy bug. Copying the derivatives directly instead is a real optimisation
only if moves become routine and large.

## Making the record move atomic

Moving a photo record crosses partitions — `pk` goes from `FOLDER#<src>` to
`FOLDER#<dst>` — so it is a delete plus a put, not an update. Four writes belong
together:

- `Delete` the photo item at `FOLDER#<src>` / `PHOTO#<uploadedAt>#<photoId>`
- `Put` the same item, `folderId` rewritten, at `FOLDER#<dst>` with the **same**
  sort key
- `Update` source folder `photoCount -1`
- `Update` destination folder `photoCount +1`

Use one `TransactWriteItems`. Four items is far inside the 100-item limit, and it
means a failure cannot leave a photo counted twice or listed in two folders.
`bumpPhotoCount` (`functions/shared/db.ts:100`) already carries the
`attribute_exists(pk)` condition that should guard both folder updates — reuse that
expression so the transaction fails cleanly if the destination folder was deleted
mid-flight.

Keep `uploadedAt` unchanged. It is half the sort key, it is deliberately not
`takenAt` (`functions/shared/db.ts:21`), and rewriting it here would reorder the
photo for no reason.

## Route

```
POST /api/folders/<folderId>/photos/<photoId>/move   { "toFolderId": "<uuid>" }
```

`admin: true`, added to the table in `functions/api/index.ts`. It should 404 on
either folder missing, 404 on the photo missing, and 400 if source and destination
are the same. Bulk moves fall out of the multi-select work — take
`{ photoIds: [...] }` if that lands first, capped like `createUploads` caps uploads
at 200.

S3 `CopyObject` handles Glacier Instant Retrieval sources without a restore step,
so a moved RAF works even after the 30-day lifecycle transition
(`infra/lib/phosto-stack.ts:73`). Note that the copy is a **new object**: it lands
in Standard and starts its own 30-day clock before transitioning again. A library
churned through folders repeatedly would pay Standard rates on RAW files that would
otherwise have aged into Glacier IR. Not a reason to avoid moving; a reason not to
build a "reorganise everything" batch tool.

## Loose ends to handle

- **Stale cover.** If the moved photo was the source folder's `coverPhotoId`, that
  pointer now aims at a photo in another folder. Clear it in the same transaction
  when `folder.coverPhotoId === photoId`. See cover photos (shipped).
- **Shares are not notified, and should not be.** A share on the source folder
  loses the photo; a share on the destination gains it. That is the correct
  meaning of a move, and it happens for free because the cookie scopes to the key
  prefix.
- **Failure mid-copy.** If the process dies after the record moves but before the
  objects copy, the photo shows as permanently `DEVELOPING` in the destination. The
  recovery is the documented re-derive trick — copy the original onto itself with
  `--metadata-directive REPLACE` — but the original is still at the *old* key at
  that point. Log both keys on every step so the manual repair is possible; a
  reconciliation job is not worth building for a single-admin library.

## Verification

No test suite exists. After implementing, verify by hand:

1. Move a paired JPEG+RAF photo between two folders; confirm four new keys exist,
   four old keys are gone, and both `photoCount`s changed.
2. Open a pre-existing share on the source folder and confirm the photo is gone
   from it — then confirm an unsigned fetch of the new `f/<dst>/…/large.webp`
   returns a refusal, which is the standing access-control canary from `CLAUDE.md`.
