# Planned work

**Nothing is planned. Every doc that was here has shipped, and this README is all
that remains of the directory.**

Each file here outlined one unbuilt feature: what already existed, what was
missing, the hazards specific to this codebase, and the smallest implementation
that worked. They existed so the API surface and data model that already
anticipated them were not mistaken for dead code and deleted — the
over-engineering audit on 2026-07-25 flagged every one of them as removable, which
was correct if they were never built and wrong if they were. They were all built.

What follows is what those docs got right and the code does not say on its own.
Add a new file here to plan the next feature, or delete this README with the
directory once nothing below is worth keeping.

Share management — list, revoke and label links — shipped on 2026-07-26 and its
doc is gone. The list can never redisplay a share URL: `createShare` returns it
once and persists only its SHA-256, which is the point of storing the hash, so
the admin view says so in place of a URL column. Expired shares stay in the list
greyed rather than filtered out, because DynamoDB TTL deletion lags up to 48
hours and a row that disappears hours later reads as a bug.

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
prefix split it describes constrained most of them, and will constrain whatever
comes next.
