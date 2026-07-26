# Planned work

Each file here outlines one unbuilt feature: what already exists, what is missing,
the hazards specific to this codebase, and the smallest implementation that works.

None of these are committed to. They exist so the API surface and data model that
already anticipate them are not mistaken for dead code and deleted — the
over-engineering audit on 2026-07-25 flagged every one of them as removable, which
is correct if they are never built and wrong if they are.

| Doc | Server today | Client today |
|---|---|---|
| [hidden-photos.md](hidden-photos.md) | none | none |
| [move-photos.md](move-photos.md) | none | none |
| [folder-settings.md](folder-settings.md) | complete | none |
| [share-management.md](share-management.md) | complete | none |

Cover photos shipped on 2026-07-26 and its doc is gone. Multi-select download
shipped on 2026-07-26 — phase 1 (sequential downloads) only, and its doc is gone
with it. Phase 2 was a client-side store-mode ZIP, deliberately not built: *n*
separate files is only a real complaint at batch sizes nobody has hit. If it ever
comes up, the two things that doc got right are that a zipping Lambda is the wrong
answer — it routes the bytes around CloudFront and into a billed Lambda response —
and that DEFLATE buys nothing on already-compressed JPEG and RAF.

Three of the five need no new API routes. `move-photos` and `hidden-photos` are the
two that need real backend work, and both move S3 objects between key prefixes —
which is also why both can corrupt the library, or quietly weaken sharing, if the
steps run in the wrong order. Read those two together.

Read [../architecture.md](../architecture.md) first if you have not — the three-way
prefix split it describes constrains most of them.
