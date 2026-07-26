# Planned work

Each file here outlines one unbuilt feature: what already exists, what is missing,
the hazards specific to this codebase, and the smallest implementation that works.

None of these are committed to. They exist so the API surface and data model that
already anticipate them are not mistaken for dead code and deleted — the
over-engineering audit on 2026-07-25 flagged every one of them as removable, which
is correct if they are never built and wrong if they are.

| Doc | Server today | Client today |
|---|---|---|

| [share-management.md](share-management.md) | complete | none |

Cover photos shipped on 2026-07-26 and its doc is gone. Multi-select download
shipped on 2026-07-26 — phase 1 (sequential downloads) only, and its doc is gone
with it. Phase 2 was a client-side store-mode ZIP, deliberately not built: *n*
separate files is only a real complaint at batch sizes nobody has hit. If it ever
comes up, the two things that doc got right are that a zipping Lambda is the wrong
answer — it routes the bytes around CloudFront and into a billed Lambda response —
and that DEFLATE buys nothing on already-compressed JPEG and RAF.

Moving photos between folders and hiding frames both shipped on 2026-07-26 and
their docs are gone with them. They are the two features that move S3 objects
between key prefixes, and they order the steps *differently* on purpose: a move
writes the record first, because the copy of the original retriggers derivation
and derive drops an event whose photo it cannot find; a hide copies the bytes
first, because the flag is the only thing naming the new keys and flipping it
early points every URL at objects that do not exist yet. See `CLAUDE.md`.

Folder settings — rename and delete — shipped on 2026-07-26 and its doc is gone.
Deleting a roll that still holds frames moves them to the orphan roll instead of
refusing, which is the one rule that outranks everything else here: this is the
owner's photo storage, not only a way to show photos, so no path through the API
may destroy an image as a side effect of tidying folders. See `ORPHAN_FOLDER_ID`
in `functions/shared/types.ts`.

Read [../architecture.md](../architecture.md) first if you have not — the three-way
prefix split it describes constrains most of them.
