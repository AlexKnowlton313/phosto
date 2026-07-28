# Feature notes

Things phosto does not do yet, one document each. Every one is written against
the code as it stands: what is missing, why it matters given this architecture,
the smallest design that works, and what it costs.

Ranked by value against effort. Range select, roll sort order, staying signed in,
bulk-download progress and the share note have shipped; a shipped note leaves the
table and its document goes with it, so what is here is what is still missing.

| # | Feature | For | Effort | Why |
|---|---|---|---|---|
| 6 | [Trash](trash.md) | admin | medium | The one irreversible action in an app otherwise built so mistakes cannot lose a photograph. ~$0.05 to hold a 100-frame delete for 30 days. |
| 9 | [Viewer picks](share-picks.md) | share viewer | small, no server | Marking frames on a contact sheet is what a contact sheet is *for*. localStorage + clipboard, no API surface. |

## Considered and not proposed

- **Per-photo captions.** Needs a field on `Photo`, presence in both
  presentations, and a decision about whether a caption follows a frame into
  every roll it is in — which, given a photo is owned by nobody, it must. The
  shipped roll-level `note` covers most of the want for one string on a record
  that already gets patched.
- **Favourites / star ratings.** A roll already *is* a set of pointers, and a
  frame can be in as many as you like. "Picks" is a roll called Picks. Adding a
  parallel marking system would be a second membership model doing the first
  one's job.
- **Drag-to-reorder within a roll.** Position has to live on the membership
  (different order per roll), the membership's sort key cannot be updated in
  place, and every drag is a write per frame. The shipped direction toggle gets
  most of the value for one optional attribute.
- **Zip downloads.** Server-side means compute in the image path, which is the
  one thing the $0.29/month depends on not existing; client-side means 580 MB in
  browser memory — 40 originals at 14.5 MB, which is a tab crash on a phone. N
  files with honest progress is the right answer at this scale; revisit as
  `showDirectoryPicker()` with `downloadEach` as the fallback, not as a zip.
- **Password-protected shares.** The token is 32 bytes of entropy stored only as
  a SHA-256 hash. A password on top guards against a forwarded link, which is
  what expiry and revocation are for.
- **Sharing an ad-hoc selection rather than a roll.** Make a roll. Attach has no
  batch cap, no S3 work, and deleting the roll afterwards destroys nothing.
- **Multi-user accounts.** Single admin is a stated constraint, and it is what
  lets the entire auth model be one Cognito user, one cookie, and one flag on a
  route.
