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
| [move-photos.md](move-photos.md) | none | none |
| [cover-photos.md](cover-photos.md) | complete | none |
| [folder-settings.md](folder-settings.md) | complete | none |
| [share-management.md](share-management.md) | complete | none |

Four of the five need no new API routes. `move-photos` is the only one that needs
real backend work, and it is the only one that can corrupt the library if it is
done in the wrong order.

Read [../architecture.md](../architecture.md) first if you have not — the three-way
prefix split it describes constrains four of these five features.
