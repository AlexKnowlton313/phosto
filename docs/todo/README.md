# Planned work

Each file here outlines one unbuilt feature: what already exists, what is missing,
the hazards specific to this codebase, and the smallest implementation that works.

None of these are committed to. They exist so the API surface and data model that
already anticipate them are not mistaken for dead code and deleted — the
over-engineering audit on 2026-07-25 flagged every one of them as removable, which
is correct if they are never built and wrong if they are.

| Doc | Server today | Client today |
|---|---|---|
| [multi-select-download.md](multi-select-download.md) | complete | none |
| [hidden-photos.md](hidden-photos.md) | none | none |
| [move-photos.md](move-photos.md) | none | none |
| [cover-photos.md](cover-photos.md) | complete | none |
| [folder-settings.md](folder-settings.md) | complete | none |
| [share-management.md](share-management.md) | complete | none |

Four of the six need no new API routes. `move-photos` and `hidden-photos` are the
two that need real backend work, and both move S3 objects between key prefixes —
which is also why both can corrupt the library, or quietly weaken sharing, if the
steps run in the wrong order. Read those two together.

Read [../architecture.md](../architecture.md) first if you have not — the three-way
prefix split it describes constrains four of these five features.
