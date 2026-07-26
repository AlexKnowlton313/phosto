# Folder cover photos

Show a chosen frame as the thumbnail on each roll card instead of a text-only tile.

## What exists

Everything on the server:

- `Folder.coverPhotoId?: string` (`functions/shared/types.ts:7`)
- `PATCH /api/folders/<id>` accepts it (`functions/api/index.ts:420`) and
  `db.updateFolder` writes it (`functions/shared/db.ts:84`)
- `GET /api/folders` returns the folder items, `coverPhotoId` included

Nothing sets it and nothing reads it. That is the entire gap.

## No API change is needed

A derivative key is fully determined by its ids:

```
f/<folderId>/<coverPhotoId>/thumb.webp
```

so the client can build the cover URL from the folder record it already has. Do
that rather than adding a `coverUrl` to the response — it keeps `presentPhoto` as
the single place that decides which keys are disclosed to whom, and the folder list
is admin-only anyway.

The admin's signed cookies are scoped to the whole `f/*` prefix
(`functions/api/index.ts:378`), so one `startSession()` already authorises every
cover thumbnail on the roll list. No new signing, no per-folder cookie juggling.

Add to `web/src/api.ts`:

```ts
coverUrl: (folder: FolderView) =>
  folder.coverPhotoId
    ? `/f/${folder.folderId}/${folder.coverPhotoId}/thumb.webp`
    : undefined,
```

and add `coverPhotoId?: string` to `FolderView`, which currently omits it
(`web/src/api.ts:26`).

## Setting a cover

One button in the lightbox, next to Delete, admin-only — the same
`onDelete && (...)` pattern the component already uses to keep viewer-facing
controls out of the share view (`web/src/components/Lightbox.tsx:121`):

```tsx
{onSetCover && (
  <button className="btn" onClick={() => onSetCover(photo)}>Set as cover</button>
)}
```

`Admin.tsx` handles it with a `PATCH` and a local state update. `adminApi` needs an
`updateFolder(folderId, patch)` method — the route exists, the client method does
not.

## Rendering

The roll card is a `<button className="roll">` with a name and a frame count
(`web/src/views/Admin.tsx:203`). With a cover it becomes a 3:2 tile with the
thumbnail behind the existing text, which the contact-sheet direction supports
directly: same aspect as a sheet cell, name and count set as edge-printing over
it. Reuse the `.frame` aspect rules rather than inventing a second ratio.

Folders without a cover keep the current text card. Do **not** fall back to "the
most recent photo" — that needs a `listPhotos` query per folder on a screen that
currently costs one `Query`, and it turns a deliberate choice into a guess that
changes whenever a new roll is uploaded.

## Edge cases

- **Cover photo deleted.** `deletePhotoAndObjects` does not clear a folder's
  `coverPhotoId`, so the tile would request a key that no longer exists and show a
  broken image. Either clear it on delete when it matches, or give the `<img>` an
  `onError` that falls back to the text card. The `onError` is one line and covers
  the moved-photo case too — see [move-photos.md](move-photos.md).
- **Cover not yet derived.** Only offer "Set as cover" for a photo with
  `ready: true`.
- **RAW-only cover.** A RAW-only photo with no JPEG sibling has no derivatives at
  all, so it is never `ready` and is excluded by the rule above. Nothing extra to
  do.

## Storage note

Zero. The cover is an existing `thumb.webp` referenced by key — no new derivative,
no new object, no change to the cost model in `../cost-estimate.md`.
