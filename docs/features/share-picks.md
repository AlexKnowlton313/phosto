# Viewer picks: letting someone tell you which frames they want

## What is missing

The share view can select frames — `useSelection` and `SelectionBar`'s footer
are shared with the admin — but selection there does exactly one thing:
*Download JPEGs*, and only when `allowDownload` is on. There is no way for a
viewer to say **which** frames they want.

That is the actual job of a contact sheet. You hand somebody the sheet and they
mark the ones to print. Here they open the link, look at forty frames, and then
write "the one with the boat, and the two of the harbour I think?" in a text
message.

## The lazy design: no server at all

The share page is a static bundle with a signed payload; every frame already has
a stable `basename` and a frame number. A pick is a client-side mark:

1. **Marking.** Reuse the existing selection entirely — a picked frame *is* a
   selected frame. Add one thing to the share footer bar: **Copy picks**.
2. **Persistence.** `localStorage`, keyed by the share token, so closing the tab
   halfway through forty frames does not lose the work. Ten lines with a
   `useEffect`.
3. **Sending them back.** `navigator.clipboard.writeText` — the same call
   `SharePanel` already uses for the share URL — with a plain list:

   ```
   Iceland — 6 picks
   04 · DSCF1182
   07 · DSCF1201
   11 · DSCF1244
   …
   ```

   They paste it into whatever they were going to reply in anyway.

4. **On the admin side**, nothing new is needed to *use* it. The frame numbers
   and basenames are what the contact sheet already shows, and the filter in
   `find-unfiled-frames.md` searches `basename` — so a pasted list is directly
   actionable.

Zero API routes. Zero DynamoDB items. Zero new attack surface on an
unauthenticated endpoint. It works on an expired link, offline, and in a browser
with cookies blocked.

## Why not store picks server-side

The tempting version is `POST /api/share/<token>/picks` and a *Picks* view in
the admin. It costs:

- a write route reachable by anyone holding a share URL — the first unauthenticated
  write in the system, and one that can be called in a loop;
- an item shape, a size cap, and a decision about what happens to picks when the
  share is revoked or the photo is detached;
- a viewer identity, or picks from two people silently merge into one list.

For "mum tells you which six to print", `localStorage` plus the clipboard does
the whole job. If picks ever need to survive the viewer's browser or come from
several people at once, the design above is the thing to build — and the
clipboard version stays as the fallback for the expired-link case.

## Cost

Zero. It ships in the existing bundle.

## Skipped

Server-stored picks (above), per-viewer identity, comments per frame, and any
notification when someone picks. You find out when they paste the list, which is
the same moment you would have read the email.
