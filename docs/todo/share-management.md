# Share management — list and revoke

See which links are live on a roll and kill one.

## What exists

The full server side, with no client at all:

- `GET /api/folders/<id>/shares` (`functions/api/index.ts:563`) returns each share
  with `tokenHash` stripped and replaced by `id: tokenHash.slice(0, 12)`
- `DELETE /api/folders/<id>/shares/<id>` (`functions/api/index.ts:584`) resolves
  that short id by prefix match and deletes the share
- `db.listSharesForFolder` queries `gsi1` on `FOLDER#<id>` / `SHARE#` prefix

Today the only kill switch for a leaked link is rotating the CloudFront signing
key, which invalidates *every* share at once. That is the reason these routes
should stay even while unused.

## The link cannot be shown again

`createShare` returns the URL exactly once and stores only the SHA-256 of the token
(`functions/api/index.ts:274`). A leaked table yields no working links, which is
the point — and it means the list can never redisplay a share URL. It shows what a
link *is* and *does*, not how to open it.

Say so in the UI. Someone will otherwise assume the missing URL is a bug and go
looking for it in DynamoDB.

## What the list shows

The response already carries everything: `folderId`, `createdAt`, `expiresAt`,
`allowDownload`, `label`, and the short `id`. There is no RAW column — shares are
JPEG-only by construction, so every row would read the same.

Render as a small table under the folder toolbar, monospace, film-edge styling to
match the header:

```
LABEL          CREATED       EXPIRES        DOWNLOAD
for mum        18 Jul 2026   in 12 days     yes        [Revoke]
—              02 Jul 2026   expired        no         [Revoke]
```

`expiresAt` is unix seconds, not ISO. Expired shares still appear in the list —
`getShare` checks the expiry in code because TTL deletion can lag up to 48 hours
(`functions/shared/db.ts:223`), and the list query does not filter at all. Render
them greyed rather than hiding them, so the delay is visible instead of confusing.

## Revoking

`DELETE`, `btn-danger`, `window.confirm` — safelight red is for destructive actions
and this is one. On success, refetch the list.

The route pattern requires exactly 12 lowercase hex characters
(`/^\/api\/folders\/([\w-]+)\/shares\/([0-9a-f]{12})$/`) and resolves by
`startsWith` against the full hashes in the folder. 48 bits of prefix against a
handful of shares per folder is not a collision risk worth engineering around, but
it is worth knowing that the match is a prefix match rather than a lookup.

## Labels

`Share.label` is accepted by `createShare`, stored, and returned by the list — it
is only ever `undefined` because the client never sends one. The create flow is a
single button with hardcoded 30 days and `allowDownload: true`
(`web/src/views/Admin.tsx:134`).

Since a list of unlabelled shares is nearly useless — "which of these three did I
send to the gallery?" — labels are effectively part of this feature, not a separate
one. Three fields now, not four: label, expiry in days, allow download. The API
clamps expiry to 1–365 days already (`functions/api/index.ts:270`), so the input
needs no validation of its own beyond being a number.

At three fields a `prompt` chain is three modal dialogs to create one link, which is
worse than one small inline form. Build the form.

## Client methods

```ts
listShares: (folderId: string) =>
  request<{ shares: ShareSummary[] }>(`/api/folders/${folderId}/shares`, {}, token),

revokeShare: (folderId: string, id: string) =>
  request<void>(`/api/folders/${folderId}/shares/${id}`, { method: 'DELETE' }, token),
```

with `ShareSummary` mirroring the stripped response shape — `id`, `folderId`,
`createdAt`, `expiresAt`, `allowDownload`, `label?`.

## Interaction with folder deletion

Already handled. `db.deleteFolder` cascades the folder's shares before dropping
its META item, so this list can never show a share whose folder is gone. The
cascade lives in `db` rather than in the route so that no later caller can delete
a folder and forget.
