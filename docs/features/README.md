# Feature notes

Things phosto does not do yet, one document each. Every one is written against
the code as it stands: what is missing, why it matters given this architecture,
the smallest design that works, and what it costs. None of them is implemented.

Ranked by value against effort — the top three are the ones worth doing first.

| # | Feature | For | Effort | Why |
|---|---|---|---|---|
| 1 | [Range select, select all, "New roll…"](range-select.md) | admin | tiny, client only | Filing a 200-frame import is 200 clicks. Attach has no batch cap; the UI is the bottleneck. |
| 3 | [Finding frames: unfiled, camera, date, name](find-unfiled-frames.md) | admin | small + one route | After the second import there is nothing distinguishing filed from unfiled. Every filter but *unfiled* is free — the data is already in memory. |
| 4 | [Card dumps: batching, duplicates, filing](import-batches.md) | admin | small | >200 files fails the whole selection. Re-importing a card silently doubles 8.6 GB with no warning. |
| 5 | [Staying signed in](session-renewal.md) | admin | small | Token and image cookie both expire at 8h and neither renews. Shows up as broken images and a 401 line; recovery is a reload you have to guess at. |
| 6 | [Trash](trash.md) | admin | medium | The one irreversible action in an app otherwise built so mistakes cannot lose a photograph. ~$0.05 to hold a 100-frame delete for 30 days. |
| 7 | [Roll sort order](roll-sort-order.md) | both | tiny | Frame 01 is currently the *last* exposure — backwards for the one metaphor the whole design runs on. |
| 8 | [A line of text on a share](share-note.md) | share viewer | tiny | Nowhere to say what a roll is, and `og:description` is missing entirely, so every link preview has an empty description line. |
| 9 | [Viewer picks](share-picks.md) | share viewer | small, no server | Marking frames on a contact sheet is what a contact sheet is *for*. localStorage + clipboard, no API surface. |
| 10 | [Bulk download: progress, don't stop at the first failure](share-bulk-download.md) | both | small | 40 frames is 11 seconds of a disabled button, and one transient failure abandons the rest with no record of what landed. |

Several share an edit. 7 and 8 are both one key added to `db.updateFolder`'s
whitelist. 1 and 4 are both `useSelection` and the `choose()` picker. 10 is the
same loop in `Share.tsx` and `SelectionBar.tsx`, which is an argument for
lifting it into `api.ts` once.

## Considered and not proposed

- **Per-photo captions.** Needs a field on `Photo`, presence in both
  presentations, and a decision about whether a caption follows a frame into
  every roll it is in — which, given a photo is owned by nobody, it must. The
  roll-level note in [share-note.md](share-note.md) covers most of the want for
  one string on a record that already gets patched.
- **Favourites / star ratings.** A roll already *is* a set of pointers, and a
  frame can be in as many as you like. "Picks" is a roll called Picks. Adding a
  parallel marking system would be a second membership model doing the first
  one's job.
- **Drag-to-reorder within a roll.** Position has to live on the membership
  (different order per roll), the membership's sort key cannot be updated in
  place, and every drag is a write per frame. See the tail of
  [roll-sort-order.md](roll-sort-order.md) — the direction toggle gets most of
  the value for one optional attribute.
- **Zip downloads.** Server-side means compute in the image path, which is the
  one thing the $0.29/month depends on not existing; client-side means 580 MB in
  browser memory. Reasoning and numbers in
  [share-bulk-download.md](share-bulk-download.md).
- **Password-protected shares.** The token is 32 bytes of entropy stored only as
  a SHA-256 hash. A password on top guards against a forwarded link, which is
  what expiry and revocation are for.
- **Sharing an ad-hoc selection rather than a roll.** Make a roll. Attach has no
  batch cap, no S3 work, and deleting the roll afterwards destroys nothing.
- **Multi-user accounts.** Single admin is a stated constraint, and it is what
  lets the entire auth model be one Cognito user, one cookie, and one flag on a
  route.

## One correction to make in CLAUDE.md

`CLAUDE.md` documents `doctor.config.mjs` at the repo root — its single disabled
rule, and why. **The file is not in the repo.** Either it was never committed or
it has been removed; `npx react-doctor` will not be reading it. Worth resolving,
since the comment it describes is the record of why two loops are deliberately
sequential.
