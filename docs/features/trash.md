# Trash: a grace period on the one irreversible action

## What is missing

Everything in this app is built so that ordinary mistakes cannot lose a
photograph. Deleting a roll never destroys a frame. Detaching is free. *Remove
from roll* and *Delete photos* are deliberately never offered side by side.
`CLAUDE.md` puts it plainly: "one misclick is the difference between a pointer
and a negative."

And then `DELETE /api/photos/<id>` removes four S3 objects and the DynamoDB row,
synchronously, with a confirm dialog as the only thing between the click and
14 MB of JPEG plus 29 MB of RAF that exist nowhere else. Bucket versioning is
off. There is no undo, no grace period, and no copy anywhere.

The scenario is not exotic: select-all on All photos (which
`range-select.md` proposes making one click), then *Delete photos* instead of
*Add to roll…*. The confirm says "Permanently delete 835 photograph(s)?" and
whether you read it is the entire safety system.

## The lazy design

Two changes, one in CDK and one in the API.

**1. Turn on bucket versioning with a 30-day noncurrent expiry.**

```ts
versioned: true,
lifecycleRules: [
  { id: 'expire-deleted', enabled: true,
    noncurrentVersionExpiration: cdk.Duration.days(30),
    expiredObjectDeleteMarker: true },
  …
]
```

A `DeleteObjects` call then writes delete markers instead of destroying bytes,
and S3 reclaims them 30 days later with no scheduler, no queue, and no code that
has to remember to run. `deleteObjects()` in `functions/api/index.ts` keeps
working exactly as written — including its `Errors` check and its collapsed
`/f/<photo>/*` invalidation, which stays necessary because the object *appears*
gone at the origin either way.

This also covers the accidents nobody plans for: a bad bulk delete, or the
`prune: false` landmine on `BucketDeployment` ever being flipped.

**2. Soft-delete the record so there is something to restore.**

`destroyPhoto` currently calls `db.deletePhoto`, which unpicks memberships and
drops the row. Keep the membership unpicking — roll counts must stay honest, and
a trashed frame must not appear in any share — but instead of deleting the item,
patch it:

```ts
{ deletedAt: <iso>, wasIn: [<folderId>, …] }
```

`listLibrary` filters `!p.deletedAt` (one line in `db.ts`, the only read path
that would return it, since every other path goes through memberships that no
longer exist). A **Trash** entry in the roll list — a second pseudo-roll beside
*All photos*, `isLibrary`-style gating already exists for exactly this shape —
lists them, and offers two actions:

- **Restore**: `DeleteObject` on the delete marker for each of the photo's four
  keys, clear `deletedAt`, re-attach to whichever `wasIn` folders still exist.
- **Delete permanently**: delete every version, then drop the row.

Restore needs `s3:DeleteObjectVersion`, which `bucket.grantReadWrite(apiFn)` does
not include — one explicit statement, scoped to the bucket.

## The one-way door

**Versioning cannot be turned off, only suspended.** Once enabled, the bucket
carries version ids forever and every overwrite leaves a noncurrent copy. In
this bucket almost nothing is ever overwritten — derivative keys are immutable,
originals are written once — so the ongoing effect is close to nil, but it is
worth knowing before enabling it rather than after.

`BucketDeployment` overwrites `index.html` and the hashed assets on every
deploy; those noncurrent versions are kilobytes and the lifecycle rule sweeps
them on the same 30-day clock.

## Cost

Real numbers from `COSTS.md`'s measured library: 14.5 MB per JPEG, 28.9 MB per
RAF, ~0.3 MB of derivatives — about **43.7 MB per frame**.

| Deleted, held 30 days | Bytes | Storage cost for that month |
|---|---|---|
| 10 frames | 0.44 GB | ~$0.005 |
| 100 frames | 4.4 GB | ~$0.05 |
| The whole library, by accident | 18.2 GB | ~$0.24 |

(RAW that has already transitioned keeps its Glacier IR class as a noncurrent
version at $0.004/GB, so the 100-frame row is ~$0.033 of JPEG and ~$0.012 of
RAW.)

One caveat that is true today and not caused by this: Glacier IR bills a 90-day
minimum, so deleting a RAW that transitioned three weeks ago costs the remaining
69 days whether or not there is a trash.

Worst realistic case is a quarter of one month's bill. The thing it buys back is
the only data in the system that cannot be regenerated.

## Skipped

Undo as a toast with a five-second window; a scheduled purge Lambda; per-item
retention settings. The lifecycle rule is the scheduler, 30 days is not a number
worth configuring, and a Trash view you can look into beats a toast you can miss.
