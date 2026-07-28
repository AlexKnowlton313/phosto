# Finding frames: unfiled, by camera, by date, by name

**Shipped.** This describes what was built and why it was built that way.

## What was missing

**All photos** was 835 frames in one flat grid, sorted `takenAt` descending, with
no way to narrow it. In particular there was no way to ask the one question the
data model creates:

> which frames are in **no roll at all**?

Uploads land in the library and in no roll, deliberately (`POST /api/uploads`
takes no folder). Filing them is a second, separate step. But after the second
import there was nothing that distinguished the 200 frames you just added from
the 635 already filed — they interleave by capture date, and if the card holds
older frames they do not even sort to the top.

The lightbox had the same blind spot: open a frame and nothing said which rolls
it was in, or that it was in none.

## Why it was cheap here

Every field a useful filter needs is **already in the payload**. `presentPhoto`
returns `takenAt`, `camera`, `lens`, `iso`, `hasRaw`, `basename`, `ready`, and
`RollView` already holds the entire list in `photos` state. Camera, date range
and RAW count were already derived from it once, in `EdgeHeader`.

So every filter except *unfiled* is pure client-side work over data already in
memory: no route, no query, no bytes.

## What shipped

**Filters** — `web/src/components/SheetFilters.tsx`, with the predicates in
`components/filters.ts`. A single row under `EdgeHeader`, on the All photos sheet
only:

- a text input matching `basename` (case-insensitive `includes`);
- a `<select>` of the cameras present, shown only when there is more than one;
- `<input type="month">` for capture month, native, no picker library;
- three toggles: *has RAW*, *undeveloped*, *in no roll*.

All of them compose into one `filterPhotos()` pass before the sheet renders. The
filtered list is what `EdgeHeader`, `ContactSheet` and `Lightbox` receive, so
frame numbers stay one-based over what is actually printed — which is correct: a
contact sheet numbers what is on it. `SelectionBar` gets the unfiltered list,
because a selection outlives a filter change.

*In no roll* stays disabled until the memberships land. With an absent map every
frame satisfies the predicate, so an optimistic render would flash the entire
library as the answer.

**Unfiled** — `GET /api/memberships`, `admin: true`, ~20 lines in
`functions/api/index.ts`:

```
GET /api/memberships  → { memberships: { <photoId>: [<folderId>, …] } }
```

A photo in no roll is **absent**, not present with an empty list — that absence is
the filter. Implemented as `listFolderMemberships` over `db.listFolders()`,
concurrently: N queries of small items, no `BatchGetItem`, no photo records. At 10
rolls that is 10 queries. The admin already loads the folder list, so the client
renders both *In no roll* and the lightbox's "In Iceland · Portfolio" line from
the same response.

It rides on `RollView`'s existing `refresh()` rather than an effect of its own,
which is what keeps it current after an attach, a detach or a delete — all of
which already call `refresh`.

### Note: `POST /api/photos/memberships` already existed, on the wrong axis

It takes a selection of photo ids and queries once per *photo*, feeding the
"3 already in this roll" note in the roll picker. For All photos that would be 835
queries. The new route fans out over folders instead. Both are now in the codebase
and it is worth knowing which is which before adding a third.

### The denormalised alternative, and why not yet

Maintaining a `folders` set on the Photo record inside the existing attach and
detach transactions would make this free — `listLibrary` would already carry it,
and the transactions already write two items, so a third cannot drift.

It is not free to adopt, and the reason is not obvious: **`deleteFolder` cascades
memberships with bare `DeleteCommand`s, outside `detachPhoto`'s transaction**
(`functions/shared/db.ts`). The set would go stale on every roll delete unless that
cascade maintained it too, which doubles its round trips inside a 15-second budget
that already carries a `ponytail:` note. Add a one-off backfill over 835 existing
photos on top.

Take it if the roll count ever grows enough that N queries per page load is the
thing that hurts. The route needs no migration to abandon, and the `ponytail:`
comment on `allMemberships` says so.

## Cost

Filters: zero.

`GET /api/memberships`: N eventually-consistent queries returning ~100-byte
items. For 835 memberships across 10 rolls, ~84 KB ≈ 21 RRU ≈ $0.000005 a call.
Called on every All-photos `refresh`, which includes each round of the pending
poll — strictly less than the `listLibrary` that round was already doing.

## Skipped

Server-side search, pagination, and any index on `basename`. The library is one
`LIB` partition and one page today; filtering 835 objects in JS is sub-millisecond.
Revisit alongside the `ponytail:` note on `LIBRARY_PK` when the library outgrows
a single query.

Filters on a roll's own sheet. A roll is already the narrowing, and *in no roll*
cannot mean anything inside one.
