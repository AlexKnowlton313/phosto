# Hiding photos

Mark a frame hidden as admin: it drops out of every share, stays in the folder, and
is filtered out of the admin grid unless the admin asks to see it.

## Short answer: yes, it is easy — with one caveat worth reading

The minimum version is a boolean and a filter:

```ts
// functions/shared/types.ts — on Photo
/** Admin-hidden. Excluded from shares; still in the folder and still downloadable by the owner. */
hidden?: boolean;

// functions/api/index.ts:302 — openShare
.filter((p) => p.derivedAt && !p.hidden)
```

plus a route to set it and a toggle in the admin toolbar. Perhaps 40 lines end to
end, most of it UI.

The caveat: **that version is enforced by API logic, not by key structure.** Every
other access decision in this codebase is structural — a share cookie is scoped to
`f/<folderId>/*` and therefore *cannot* reach an original or a RAW regardless of
how the API behaves. A photo hidden by a list filter is different: its derivatives
still sit under `f/<folderId>/…`, so any cookie valid for that folder still fetches
them if the URL is known.

That matters more here than it first looks, because of *why* people hide photos.

## The threat model is a bookmark, not a brute-force

`photoId` is a v4 UUID, so nobody guesses `f/<folderId>/<photoId>/large.webp`. The
realistic case is the ordinary one:

> You share a roll. Someone opens it. You then decide one frame should not have
> been in there and hide it.

Their browser already has that URL — in history, in cache, in an open tab. The
list-filter version does not revoke it. They keep it for as long as the share
cookie lives (`SHARE_TTL`, 12 hours, `functions/api/index.ts:35`) and can renew it
simply by opening the share link again, which mints a fresh cookie for the whole
folder prefix.

Since "I changed my mind about this frame" is the main reason to hide anything, the
weak version fails in exactly its most common scenario. So build the structural one.

## Structural version: move the derivatives out of the folder prefix

A hidden photo's derivatives move from

```
f/<folderId>/<photoId>/{thumb,large}.webp
```

to

```
f/hidden/<folderId>/<photoId>/{thumb,large}.webp
```

That single change does all the work:

- A share cookie signed for `f/<folderId>/*` (`functions/shared/keys.ts:20`) does
  **not** match `f/hidden/<folderId>/…` — the literal prefix diverges before the
  wildcard. The photo becomes unreachable to every share on that folder, including
  ones already issued and cookies already in a browser.
- The admin session cookie is signed for the whole `f/*` prefix
  (`functions/api/index.ts:378`), so the owner keeps seeing hidden frames with no
  second cookie and no new signing path.
- The keys stay under `f/`, so the existing signed CloudFront behavior
  (`[`${PREFIX.derived}*`]`) already covers them. No new distribution behavior, no
  stack change at all.

`folderId` is a UUID, so the literal segment `hidden` can never collide with a real
folder.

This is the same trick the three-prefix split already uses — make the key path
express the permission — applied one level down.

### What does not move

Originals and RAWs stay where they are. They are reached through one-off signed
URLs minted per request by `shareDownload` (`functions/api/index.ts:328`), which
already gates on `allowDownload` / `allowRaw` in code. Adding a hidden check there
is consistent with how downloads are already protected:

```ts
if (photo.hidden) throw new HttpError(404, 'Photo not found');
```

A 404 rather than a 403 — a share should not be able to distinguish "hidden" from
"never existed".

## Implementation

### Data

One optional field on `Photo`. Absent means visible, so existing photos need no
backfill.

### Key helper

`derivedKey` (`functions/shared/keys.ts:7`) takes a fourth argument:

```ts
export const derivedKey = (
  folderId: string,
  photoId: string,
  name: DerivativeName,
  hidden = false,
) => `${PREFIX_DERIVED}${hidden ? 'hidden/' : ''}${folderId}/${photoId}/${name}.webp`;
```

Every existing caller keeps working unchanged. Three then need the flag passed:

- `presentPhoto` (`functions/api/index.ts:102`) — so admin URLs point at the real
  bytes
- `deletePhotoAndObjects` (`functions/api/index.ts:229`) — or deleting a hidden
  photo leaves both derivatives billed forever
- the derive Lambda (`functions/derive/index.ts:70`) — it already loads the photo
  record before writing, so pass `photo.hidden`. Without this, re-deriving a hidden
  photo silently republishes it at the visible key.

### Route

```
PATCH /api/folders/<folderId>/photos/<photoId>   { "hidden": true }
```

`admin: true`. `db.updatePhoto` (`functions/shared/db.ts:175`) already takes a
partial patch and skips undefined fields, so the handler is a `findPhoto`, the S3
move, and one `updatePhoto`.

### Ordering of the S3 move

Copy, then flip the flag, then delete — the same discipline as
[move-photos.md](move-photos.md):

1. Copy both derivatives to the destination key.
2. `updatePhoto` with the new `hidden` value.
3. Delete the source objects.

Both copies exist during the window, so neither the admin grid nor an open share
renders a broken image mid-flight. Reversed, there is an instant where the flag
points at bytes that are not there yet.

Two small objects per hide — a thumb and a large webp, a few hundred KB. Negligible
next to the re-decode that [move-photos.md](move-photos.md) accepts.

## Admin UI

`hidden` joins the fields `presentPhoto` returns, then the admin view mirrors the
negatives toggle exactly (`web/src/views/Admin.tsx:245`):

```tsx
const hiddenCount = photos.filter((p) => p.hidden).length;
```

- Grid filters out hidden frames by default.
- `Show hidden (n)` appears in the toolbar only when `hiddenCount > 0`.
- Lightbox gets a `Hide` / `Unhide` button, admin-only via the same optional-prop
  pattern as `onDelete` (`web/src/components/Lightbox.tsx:121`).
- Frame numbering: number the *visible* sequence. A contact sheet numbers the
  frames on the sheet, and a gap at 07 would advertise that something was removed —
  which is the opposite of the point.

Persisting the toggle per folder, the way [folder-settings.md](folder-settings.md)
proposes for `rawVisibleDefault`, is not worth it here. Hidden should default to
out of sight every time the folder is opened; that is the whole feature.

### Design

Neither `--amber` (negatives/RAW) nor `--safelight` (destructive) applies — hiding
is neither, and both accents are spoken for. When hidden frames are shown, render
them at reduced opacity with a `HIDDEN` tag set like the existing `frame-pending`
label. Reads as a frame marked out on the sheet rather than a new colour language.

## Interactions

- **Multi-select.** Bulk hide falls straight out of
  [multi-select-download.md](multi-select-download.md) — same selection set, one
  more toolbar action.
- **Moving a hidden photo.** The folder segment appears in the hidden key too, so a
  move must copy `f/hidden/<src>/…` → `f/hidden/<dst>/…`. Have the move read
  `photo.hidden` and build both sides with `derivedKey`; do not hardcode the
  visible path.
- **Cover photos.** Do not offer a hidden frame as a cover, and clear
  `coverPhotoId` if the current cover is hidden — otherwise the roll card
  advertises the frame you just took out of circulation. See
  cover photos (shipped).
- **Share photo counts.** `openShare` computes `photoCount` from the filtered list
  (`functions/api/index.ts:313`), so the count is correct with no extra work. The
  folder's own `photoCount` should keep counting hidden photos — they are still in
  the folder, and it is the admin's number.

## Verification

The access-control canary from `CLAUDE.md`, run twice:

1. With a live share open in a second browser, hide a frame. Reload the share: the
   frame is gone from the sheet, and the derivative URL that browser already
   loaded now returns a refusal rather than an image. **This is the check the
   list-filter-only version fails.**
2. Confirm the admin grid still renders it under `Show hidden`, and that
   `POST /api/share/<token>/photos/<photoId>/original` returns 404 for it.
