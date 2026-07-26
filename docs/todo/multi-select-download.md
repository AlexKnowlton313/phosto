# Multi-file select and download

Select several frames on the contact sheet and download them in one action.

## What exists

Nothing on the client. The server needs no changes at all:

- `POST /api/folders/<id>/photos/<photoId>/original|raw` (`functions/api/index.ts:462`)
  and the share equivalent (`functions/api/index.ts:513`) already mint a one-off signed URL per object.
- `saveAs()` in `web/src/api.ts` already triggers a browser download from one.
- Permission gating already lives in `shareDownload` — `allowDownload` and
  `allowRaw` are checked per request, so a batch cannot widen what a share allows.

The whole feature is client-side.

## Phase 1 — sequential downloads

The lazy version, and the one to ship first.

1. **Selection state in `Admin.tsx` / `Share.tsx`.** `const [selected, setSelected]
   = useState<Set<string>>(new Set())` keyed by `photoId`. Pass `selected` and an
   `onToggle` down through `ContactSheet` to `Frame`.
2. **`Frame` becomes selectable.** When selection is non-empty, a click toggles
   instead of opening the lightbox; otherwise it opens as it does now. That avoids
   a mode toggle in the toolbar — the first selection *is* the mode. Enter the mode
   with a checkbox affordance that appears on hover/focus in the frame corner.
   Escape clears the selection.
3. **Toolbar actions** appear only when `selected.size > 0`: `n selected`,
   `Download JPEGs`, `Download RAWs` (only if `showNegatives` and at least one
   selected frame has `hasRaw`), `Clear`.
4. **The download loop** reuses the existing single-photo call:

   ```ts
   for (const photoId of selected) {
     saveAs(await api.download(folderId, photoId, kind));
     await new Promise((r) => setTimeout(r, 150));
   }
   ```

   Sequential, not `Promise.all`: browsers rate-limit programmatic downloads, and a
   burst of 40 `<a download>` clicks gets silently dropped after the first few.
   Chrome also shows a one-time "Allow multiple downloads?" prompt on the first
   batch — expected, not a bug.

Cost of phase 1: no new routes, no new dependency, roughly 60 lines of UI.

### Known ceilings

- One API round-trip per photo to mint each signed URL. Fine at 20 photos, sluggish
  at 200. The fix when it matters is a batch route returning `n` signed URLs in one
  response — the signing key is already cached per container
  (`functions/shared/signing.ts:14`), so the marginal cost of the 50th URL is
  negligible; it is the HTTP round-trips that hurt.
- `DOWNLOAD_TTL` is 5 minutes (`functions/api/index.ts:36`). A 200-file batch on a
  slow connection can outlive the URL signed at the start of the loop. Mint each URL
  immediately before its download — which the loop above does — rather than
  pre-minting the whole batch.
- The user gets *n* separate files in their downloads folder. This is the real UX
  complaint that leads to phase 2.

## Phase 2 — a zip, only if phase 1 is genuinely annoying

**Do not build this server-side.** A Lambda that zips selected objects would read
them from S3 and stream them back out through API Gateway, which means the bytes
leave AWS through the Lambda response instead of through CloudFront: slower, no
caching, and egress billed on a project whose entire budget is ~$0.29/month. It
also runs into the Lambda response size limit long before it runs into the timeout.

Client-side is correct here because the browser must receive the bytes anyway. The
photos are already fetched over CloudFront with the cookies or signed URLs that
exist today; zipping happens after they arrive, on hardware that is not billed.

If it comes to that, write a **store-mode ZIP** rather than adding a dependency.
JPEG and RAF are already compressed, so DEFLATE buys nothing — a stored zip is a
local file header per entry, the payloads, and a central directory. That is ~100
lines including a CRC-32 table, against a library that would only do the same thing
more generally.

```
ponytail: store-mode zip, no ZIP64 — breaks past 4 GB total or 65,535 entries.
          Reach for a streaming zip library only when a real batch hits that.
```

Buffering the archive in memory caps a batch at roughly 300–400 MB before mobile
Safari starts failing allocations. Streaming to disk via the File System Access API
avoids that but is Chromium-only, so it would need the in-memory path as a fallback
either way. Not worth building until someone complains.

## Design

Selection marks must not use `--amber` (reserved for negatives/RAW) or
`--safelight` (destructive actions only) — see the design direction in `CLAUDE.md`.
A selected frame should read as a grease-pencil mark on a contact sheet: a thick
off-white inset outline plus a filled check in the corner where `frame-no` already
sits. That keeps the two existing accent colours doing exactly one job each.

## Accessibility

The frames are already `<button>`s. Selection needs `aria-pressed={isSelected}` on
each, and the toolbar count should live in an `aria-live="polite"` region so a
screen reader hears "3 selected" without moving focus. Shift-click range selection
is nice on desktop but must not be the only way to select a run — keep plain
per-frame toggling working with the keyboard.
