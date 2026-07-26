# Folder settings — rename, RAW default, delete

Three small capabilities that share one API route and one piece of UI.

## What exists

The whole server side:

| Capability | Route | Handler |
|---|---|---|
| Rename | `PATCH /api/folders/<id>` | `functions/api/index.ts:413` |
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

## Delete folder

note: we should have a default folder where orphans go. This folder should not be allowed to be deleted. WE NEVER WANT TO LOSE PHOTOS, THIS IS THE PHOTO STORAGE FOR MY IMAGES AS WELL AS A SITE TO SHARE THEM.

The API refuses to delete a folder that still holds photos, with a 409 naming the
count (`functions/api/index.ts:433`). So the UI is: offer `Delete roll` only when
`photos.length === 0`, confirm with `window.confirm`, and surface the API message
if the 409 comes back anyway — it can, if a bulk upload landed between the render
and the click.

`btn-danger` / safelight red, per the design rule that reserves `--safelight` for
destructive actions.

In the UI, if we try to delete a folder with photos, prompt the user with a button
that bulk moves all photos to the orphaned folder, then allow the user to delete.

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

`updateFolder` already exists in `web/src/api.ts` — cover photos added it. Build
it once, whichever feature lands first.

## Not in scope

`GET /api/folders/<id>` (`functions/api/index.ts:403`) exists and is used by none
of this — the folder list already carries every field. It stays because a
folder-detail fetch is the obvious thing to need the moment anything deep-links to
a folder, which the router does not support today (`/s/<token>` is the only
client-side route).
