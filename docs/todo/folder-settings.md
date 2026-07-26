# Folder settings — rename, RAW default, delete

Three small capabilities that share one API route and one piece of UI.

## What exists

The whole server side:

| Capability | Route | Handler |
|---|---|---|
| Rename | `PATCH /api/folders/<id>` | `functions/api/index.ts:413` |
| RAW visible by default | same route, `rawVisibleDefault` | same |
| Delete folder | `DELETE /api/folders/<id>` | `functions/api/index.ts:427` |

`db.updateFolder` (`functions/shared/db.ts:84`) already skips undefined fields and
bumps `updatedAt`, and carries `attribute_exists(pk)` so a patch against a deleted
folder fails rather than resurrecting it as a partial item.

The client has none of them: `adminApi` (`web/src/api.ts:88`) exposes only
`createFolder`, `listFolders`, and `listPhotos`.

## Rename

`window.prompt`, seeded with the current name. That is not a placeholder for a
modal — `newFolder` (`web/src/views/Admin.tsx:71`) and both destructive
confirmations already use `prompt`/`confirm`, and this app has exactly one user.
Introducing a modal component for a single text field would be the first piece of
UI infrastructure in a codebase that has so far avoided needing any.

Trigger it from the folder header. `EdgeHeader` is shared with the share view
(`web/src/components/ContactSheet.tsx:75`), so pass an optional `onRename` and
render the affordance only when it is supplied — the same admin-only pattern
`Lightbox` uses for `onDelete`.

Empty or whitespace-only input cancels. The API enforces this too, so it fails
safe either way.

## RAW visible by default

`rawVisibleDefault` is read on every folder open — `setShowNegatives(
folder.rawVisibleDefault)` (`web/src/views/Admin.tsx:49`) — but is hardcoded
`false` at creation (`functions/api/index.ts:139`) and never written after. The
plumbing is complete; only the write is missing.

Make the existing negatives toggle persist its state: when the user flips
`Show negatives`, PATCH `rawVisibleDefault` to match. No new control, no settings
panel — the toggle simply remembers. Fire and forget with a `.catch()`; a failed
persist should not fight the local state the user just changed.

Only show it when the folder has RAW frames, which the toolbar already gates on
(`rawCount > 0`).

## Delete folder

The API refuses to delete a folder that still holds photos, with a 409 naming the
count (`functions/api/index.ts:433`). So the UI is: offer `Delete roll` only when
`photos.length === 0`, confirm with `window.confirm`, and surface the API message
if the 409 comes back anyway — it can, if a bulk upload landed between the render
and the click.

`btn-danger` / safelight red, per the design rule that reserves `--safelight` for
destructive actions.

### Orphaned shares

`db.deleteFolder` (`functions/shared/db.ts:112`) deletes only the folder's `META`
item. Shares live at `SHARE#<tokenHash>` with `gsi1pk = FOLDER#<id>`, so they
survive their folder.

This fails safe — `openShare` fetches the folder and 404s when it is gone
(`functions/api/index.ts:298`) — so a stale share cannot expose anything. But the
items linger until their TTL, up to 365 days.

Cascade them: query `listSharesForFolder` and delete each before deleting the
folder. It is four lines in the route handler, and since deletion is already
restricted to empty folders the share list is small. The alternative — leaving them
for TTL — is defensible but leaves rows that no longer mean anything, and
[share-management.md](share-management.md) would list shares for a folder that no
longer exists if the query is ever run by id.

## One client method covers two of the three

```ts
updateFolder: (folderId: string, patch: Partial<FolderView>) =>
  request<FolderView>(`/api/folders/${folderId}`,
    { method: 'PATCH', body: JSON.stringify(patch) }, token),

deleteFolder: (folderId: string) =>
  request<void>(`/api/folders/${folderId}`, { method: 'DELETE' }, token),
```

`updateFolder` is the same method [cover-photos.md](cover-photos.md) needs. Build
it once, whichever feature lands first.

## Not in scope

`GET /api/folders/<id>` (`functions/api/index.ts:403`) exists and is used by none
of this — the folder list already carries every field. It stays because a
folder-detail fetch is the obvious thing to need the moment anything deep-links to
a folder, which the router does not support today (`/s/<token>` is the only
client-side route).
