# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## phosto

Self-hosted photo gallery on AWS. One library of photographs; folders are sets of
pointers into it, so a frame can be in several rolls or none. Unlisted share links
per roll, RAW files owner-only. Live at `photos.alex-knowlton.com`, single admin,
~$0.29/month all-in — of which ~$0.20 is storage once RAW ages into Glacier IR
(`COSTS.md`).

## Layout

```
infra/      CDK stack — the single source of truth for all AWS resources
functions/  api (HTTP handler) + derive (S3-triggered image pipeline) + shared/
web/        Vite + React. Admin UI and the public share view
scripts/    key bootstrap
```

## Commands

```bash
npm run typecheck                  # tsc over infra, functions, web — scripts/ is plain .mjs
npm run build:web
npm run dev --workspace web        # vite on :5173
npm run build:layer                # sharp + libheif-js for linux-arm64
npm run diff                       # cdk diff
npm run deploy                     # layer + web build + cdk deploy
```

**There is no test suite** — no runner, no test files, no `npm test`. Don't go
looking for one, and don't imply coverage that doesn't exist. The verification loop
is `npm run typecheck`, then `npm run diff` to read the CloudFormation change, then
the access-control canary described below.

`npx react-doctor` lints `web/` and currently scores 85. Three warnings, all
known: `async-await-in-loop` twice — both loops are sequential on purpose, one
because concurrent membership changes contend on a roll's `photoCount` in
DynamoDB, the other because browsers drop a burst of programmatic downloads —
and `no-giant-component` on `RollView` and `Lightbox`, which are one screen and
one modal respectively and do not want splitting into pieces that only ever
appear together.

`functions/layers/*/nodejs/` is gitignored and CDK reads it with `Code.fromAsset`,
so a bare `npx cdk synth`/`deploy` on a fresh clone fails until `npm run
build:layer` has run. `npm run deploy` does it first. The sharp version is pinned
twice — `SHARP_VERSION` in `functions/build-layer.sh` (the deployed binary) and
`functions/package.json` devDependencies (types only, since the layer supplies the
runtime copy). If they drift, the types describe a different sharp than the one in
Lambda.

Deploying needs `infra/config.json` (gitignored — copy `config.example.json`) and
`infra/keys/cloudfront-public.pem` from `npm run bootstrap:keys`.

`--require-approval broadening` fails without a TTY. Non-interactive deploys need
`npx cdk deploy --require-approval never`, after reading the IAM diff.

## The three prefixes

This is the most important thing to understand before changing anything.

```
f/<photoId>/{thumb,large}.webp   derivatives — admin COOKIE, share SIGNED URL
orig/<photoId>.<ext>             originals   — signed URL, per object
raw/<photoId>.<ext>              RAW         — signed URL, per object
```

**No folder id appears in any key.** A photo can be in several rolls at once, so
nothing about its storage can name one. Folders are membership records, not
containers.

The three stay separate for two independent reasons, and collapsing them breaks
both:

1. **The admin cookie covers `f/*` only,** so it structurally cannot reach an
   original or a RAW no matter how the API behaves. JPEG downloads are one-off
   signed URLs gated on `allowDownload`; RAW is owner-only and has no share route.
2. **The derive Lambda listens on `orig/` and `raw/` and writes to `f/`.** Sharing a
   prefix between input and output would make every write retrigger the function.

### How a share is authorised

There is no compute in the image path — CloudFront serves derivatives straight
from S3, which is what makes this cost $0.29/month — so the only authorization
primitive available is *a signature over a URL pattern*. A CloudFront policy
permits exactly one `Resource` statement with `*`/`?` wildcards, and a photo in
three rolls has one set of bytes under no roll's prefix. **There is therefore no
wildcard that names exactly one share's photos.**

So a share gets **one signed URL per derivative per photo**, minted in `openShare`
via `signObjectUrl` — the same mechanism originals and RAWs already used. Each URL
is a capability for exactly one object, which is a *tighter* grant than the
folder-wide cookie it replaces. The admin still gets a cookie for `f/*`, because
signing ~400 URLs on every grid load would be waste for a credential the browser
already holds. `presentPhoto`'s `sign` flag is where that fork lives.

**The cost of this, and it is real: a signed URL outlives the record it was minted
from.** Detaching a photo from a roll changes no bytes — they may be in other
rolls — so a URL already issued keeps working until it expires (`SHARE_TTL`, 12h).
There is no server-side revocation, and an invalidation does not help: the object
still exists and the signature is still valid. Shorten `SHARE_TTL` if that window
matters. This is inherent to a flat store: instant revocation means moving bytes,
which is exactly what a photo in several rolls cannot do.

**Deleting still needs the edge.** Derivatives are written `immutable, max-age=1y`
and `f/*` is on `CACHING_OPTIMIZED`, so removing the object at the origin does not
stop a POP serving the copy it already has. Every removal goes through
`deleteObjects()` in `functions/api/index.ts` — never a bare
`DeleteObjectsCommand`. It does two things no caller should repeat: checks
`Errors` in the *response*, because `DeleteObjects` reports per-key failures there
rather than throwing and an unchecked partial delete returns success on a frame
that is still readable; and invalidates, collapsed to one `/f/<photo>/*` wildcard
per photo rather than one path per key, which is what keeps a bulk delete inside
CloudFront's free 1000 paths/month. The API holds
`cloudfront:CreateInvalidation` for this; the distribution id travels through SSM
because `Distribution → HttpApi → ApiFunction` means an env var or an ARN-scoped
grant would close a CloudFormation cycle.

The cover is a third route to the same bytes: `/s/<token>/og.webp` streams it at
2400px with **no cookie at all** and is edge-cached for `PREVIEW_TTL`, so
clearing `coverPhotoId` in DynamoDB does not stop it unfurling. Anything that
drops a cover calls `invalidatePreviews()` too. It invalidates `/s/*` rather
than the exact URLs because the path carries the plaintext token and only its
SHA-256 is stored — the URLs cannot be reconstructed.

Verify access control with a canary rather than by reading the config: upload an
object with known bytes under `f/` and confirm an unsigned fetch does not return
them.

## Adding an API route

`functions/api/index.ts` is a single Lambda behind `/api/{proxy+}`, dispatched by a
hand-rolled table of `{ method, pattern, admin, handle }` near the bottom of the
file. The router is the only place authentication happens: `admin: true` makes it
run `requireAdmin` (verifies a Cognito access token) before the handler, so a new
protected route needs that flag and nothing else. Handlers signal failure by
throwing `HttpError(status, message)`; anything else becomes a 500 with the detail
logged rather than returned.

`presentPhoto` shapes both the admin and the share response. It takes
`allowDownload` / `allowRaw` / `sign` and omits what the caller may not have, so
original and RAW keys never appear in a payload that isn't permitted to fetch them
— the API counterpart to the prefix split above. `openShare` always passes
`allowRaw: false`: shares are JPEG-only by construction, so the admin view is the
only place `hasRaw` is ever true and the only place a Download RAW button appears.

Two credential types come out of this Lambda and they are not interchangeable: one
signed **cookie** for `f/*`, issued only to the admin, and single-object signed
**URLs** for everything else — every share derivative, plus all originals and RAWs.
Both are minted in `functions/shared/signing.ts` from the SSM-held private key,
cached per container but never cached as a rejected promise.

Routes that take a photo do **not** take a folder: a photo belongs to no folder, so
`/api/photos/<id>` is the whole path. `/api/folders/<id>/photos` is the membership
route — `PUT` attaches, `DELETE` detaches, and neither destroys anything.
`DELETE /api/photos/<id>` **trashes**: it unpicks every membership and marks the
record, and touches S3 not at all. `DELETE /api/trash/<id>` is the only route in
the API that can lose a photograph, and it only reaches a frame the first one has
already thrown away.

### The trash

A trashed photograph keeps **every byte it owns, exactly where it was**. There is
no bucket versioning, no delete marker, no lifecycle rule and no scheduler:
`deletedAt` on the record takes the frame out of `listLibrary`, unpicking the
memberships takes it out of every roll, and `POST /api/photos/<id>/restore` puts
both back from the `wasIn` list. Restoring is a record edit — it makes no S3 call
at all, which is why the trash renders as a real contact sheet rather than a list
of filenames.

**What that costs, and it is the only thing it costs:** a signed derivative URL
minted before the frame was trashed keeps resolving until it expires
(`SHARE_TTL`, 12h), where destroying the photograph outright 404s it at once.
Only a viewer who already had the share open holds one — the share stops listing
the frame the moment its membership goes, and `shareDownload` re-checks
membership per request, so no *new* URL can be minted for it. Emptying the trash
is the sweep that does 404.

**Nothing purges the trash on a timer.** That is deliberate — a 30-day clock you
cannot see is a bill you find later — so the trash sheet prints its own frame
count and gigabytes, and *Destroy permanently* is the only thing that reclaims
them.

`db.getPhoto` is where all of this is enforced: see the landmine below before
adding a route that reads a photo.

There are **two membership-reading routes and they fan out on opposite axes.**
`POST /api/photos/memberships` takes a selection of photo ids and queries once per
*photo* — it feeds the "3 already in this roll" note in the roll picker, and it is
the wrong shape for the whole library (one query per frame). `GET /api/memberships`
queries once per *folder* and returns every membership keyed by photo id, which is
what All photos filters *unfiled* on and what tells the lightbox which rolls a frame
is in. Neither needs an IAM change; both are DynamoDB reads the API already holds.
Measured against the live table — 4 rolls, 648 memberships — the folder-side fan-out
is 27 RRU, $0.0000034 a call.

Membership cannot ride along on the library payload, and this is worth knowing
before someone tries: membership hangs off the **photo's** partition under a
`FOLDER#` sort key, while `listLibrary` reads the `LIB` gsi1 partition, which holds
META items only. The denormalised alternative — a `folders` set on the photo record,
maintained inside the attach/detach transactions — is noted as the upgrade path in
`allMemberships`. It is not free: `deleteFolder` drops memberships with bare
`DeleteCommand`s *outside* those transactions, so its cascade would have to maintain
the set too, and every existing photo would need a backfill.

`POST /api/photos/<id>/develop` re-runs the pipeline for one frame: it copies the
photo's `orig/` key (or `raw/`, when there is no original) onto itself with
`MetadataDirective: 'REPLACE'`, which re-fires the S3 notification. That is the
operational note below as a route, so it needs no IAM change — the API already
holds `bucket.grantReadWrite`. It writes nothing to the record: `derivedAt`
belongs to derive. 202, not 200; the derivatives land seconds later and the UI
polls. It cannot fix a RAW-only frame in a format with no preview extractor —
`createUploads` names those in `noPreview` at upload time instead.

`functions/` is `module: NodeNext`, so relative imports must carry a `.js`
extension even though the sources are `.ts` — `import * as db from
'../shared/db.js'`. `web/` uses `moduleResolution: bundler` and does the opposite,
so don't copy an import style between the two.

## Landmines

Each of these shipped as a real bug. They are in the code with comments; this is
the index.

- **Lambda bundling.** `format: ESM` needs the `createRequire` banner in
  `phosto-stack.ts`. The AWS SDK's CJS internals call `require()`; without the
  banner both functions die at *init* with `Dynamic require of "node:https"`,
  before any handler code runs, which reads like an IAM or trigger problem.
- **No distribution-wide `errorResponses`.** They apply to every behavior, so
  mapping 403→200 `/index.html` turns a refused photo into a 200 HTML page. SPA
  routing is a CloudFront Function on the default behavior only.
- **`sharp` in the layer needs `--libc=glibc`.** Without it npm silently skips the
  linux-arm64 binary and *exits 0* with an empty `@img/`. `build-layer.sh` checks
  for the `.node` file, not the directory.
- **`libheif-js/wasm-bundle.js` — the `.js` is required.** The package has no
  `exports` map, so the extensionless subpath fails at decode time, not deploy
  time. Only the HEIC files break; everything else looks healthy.
- **EXIF comes from the source bytes, not the decode pipeline.** A HEIC decodes to
  raw RGBA with no metadata. `sharp` reads a HEIF container's metadata without
  decoding its pixels.
- **EXIF strings are NUL-padded and rationals can be `NaN`.** `.trim()` does not
  strip NULs and `typeof NaN === 'number'`, which produced `f/NaN` and a lens made
  of null bytes. Use `cleanString` / `finiteNumber` in `derive/exif.ts`.
- **`BucketDeployment` must keep `prune: false`.** The site and the photos share a
  bucket; pruning would delete the entire library.
- **Percentage `max-height` needs a definite containing block.** The lightbox used
  `display: grid` + `place-items: center`, which auto-sizes the track to the
  image, so `max-height: 100%` constrained nothing and desktop showed a cropped
  crop. It reproduced *only* on desktop — narrow viewports are width-bound.
- **Signed object URLs must have no query string.** A canned policy's `Resource`
  is the whole URL, so any extra parameter has to survive round-tripping into
  CloudFront byte-for-byte — `response-content-disposition` did not, because
  `URLSearchParams` encodes the space in `attachment; filename=` as `+`. The
  failure is a CloudFront `<Code>AccessDenied</Code><Message>Access
  denied</Message>`, which looks like a key-group problem but is a signature
  mismatch. (S3's own denial says "Access Denied" and carries a `RequestId`.) The
  parameter was inert regardless: the signed behaviors use `CACHING_OPTIMIZED`,
  query strings `none`, so CloudFront drops it before S3. Download filenames come
  from `saveAs()` and `<a download>` in `web/src/api.ts` — same-origin, so the
  attribute is honored.
- **`/s/*` is not a static route.** It has its own CloudFront behavior
  pointing at the API Lambda, which renders `index.html` with the folder's OG
  tags injected before `</head>` so link previews show the roll name and cover
  (`GET /s/<token>` and `GET /s/<token>/og.webp` in `functions/api/index.ts`,
  the only two routes outside `/api`). Three things this depends on: the head
  must keep a literal `</head>`; the Lambda reads the *deployed* `index.html` at
  request time, because vite's asset hashes change every build; and the behavior
  must stay off the SpaRouting function, which would rewrite the path back to
  the static file. The cover is streamed through the Lambda rather than copied
  to a public prefix — `f/*` stays cookie-only, and the preview expires with the
  share instead of leaving an orphan.
- **`vite.config.ts` needs `define: { global: 'globalThis' }`** for
  `amazon-cognito-identity-js`, which otherwise builds clean and throws at runtime.
- **DynamoDB `UpdateItem` upserts, so `updatePhoto` carries
  `attribute_exists(pk)`.** Every caller holds an item it read earlier, and
  derive reads the photo and then spends *seconds* decoding a RAF. Delete the
  frame in that window and an unguarded update recreates the row from its key
  plus the patch: no `photoId`, no `basename`. `listLibrary` returns it because
  the gsi1 projection still matches and the grid renders
  `/f/undefined/thumb.webp`. It returns `false` instead of throwing — the record
  being gone is a race, not a failure. Derive pairs that with a re-read after
  `writeDerivatives`: a `null` there means the frame was deleted mid-decode, and
  the derivatives it just wrote landed *after* the sweep meant to remove them, so
  it deletes them rather than strand bytes no record names.
- **A signed object URL is a capability that outlives the record it came from.**
  Detaching a photo from a roll, or clearing a cover, changes no bytes — so any
  URL already handed out keeps working until it expires. Nothing server-side
  revokes it, and an invalidation does not help: the object exists and the
  signature is valid. Only `SHARE_TTL` bounds it. Do not write code, or docs,
  that describes detaching as a revocation.
- **`presentPhoto` is async and signs per object.** Calling it in a `.map()`
  without `Promise.all` yields an array of promises that `JSON.stringify` renders
  as `[{},{}]` — a 200 with an empty-looking payload rather than an error.
- **`db.getPhoto` hides trashed frames; `db.getAnyPhoto` does not.** Reach for
  `getPhoto` in anything that acts on a photograph — develop, download, attach
  to a roll, a share's membership check — because a trashed frame has to refuse
  all of them and one guard in the shared read is the whole fix. `getAnyPhoto`
  exists for exactly two callers and picking it by accident is how a frame in
  the bin becomes downloadable again: the trash routes, which act *on* a trashed
  record, and derive, which asks the narrower question "is there still a row to
  attach these derivatives to" — a frame trashed mid-decode keeps its bytes and
  wants its derivatives written, where a *purged* one must have them swept.

## Data model

One DynamoDB table, reached only through `functions/shared/db.ts`:

| Item | pk | sk | gsi1pk / gsi1sk |
|---|---|---|---|
| Folder | `FOLDER#<id>` | `META` | `ROOT` / `<createdAt>#<id>` |
| Photo | `PHOTO#<id>` | `META` | `LIB` / `<uploadedAt>#<id>` |
| Membership | `PHOTO#<id>` | `FOLDER#<fid>` | `FOLDER#<fid>` / `PHOTO#<uploadedAt>#<photoId>` |
| Share | `SHARE#<sha256>` | `META` | `FOLDER#<id>` / `SHARE#<createdAt>` |

**A photo is owned by nobody.** It is a row in one library; a folder is a set of
pointers at rows. That is what lets one frame appear in several rolls, and it is
why deleting a folder can no longer destroy an image — nothing lives *inside* one.

`gsi1` is overloaded three ways: `gsi1pk = ROOT` lists every folder, `gsi1pk = LIB`
lists every photo, and `gsi1pk = FOLDER#<id>` holds both that folder's shares
(`SHARE#…`) and its photos (`PHOTO#…`) — two `begins_with` queries on one
partition. `LIB` is a single partition; at 835 photos that is one page, and the
`ponytail:` comment on `LIBRARY_PK` names the upgrade path.

A trashed photo keeps `gsi1pk = LIB`: `listLibrary` and `listTrash` are the same
query with opposite filters on `deletedAt`, so the trash costs no second
partition and no second index. Give it its own `gsi1pk` if it ever holds enough
frames for the wasted read units to matter.

Membership sort keys use `uploadedAt`, **not** `takenAt` — the derive Lambda
corrects `takenAt` from EXIF, and a sort key cannot be updated in place. Callers
sort by `takenAt` after reading. Listing a folder is therefore two round trips: a
`gsi1` query for memberships, then a `BatchGetItem` for the photo records. The
alternative — copying photo fields onto every membership — would make each EXIF
correction fan out to every roll the frame is in.

A JPEG and a RAW sharing a basename (`XT300024.JPG` + `.RAF`) are **one** photo
with `hasRaw: true`. That pairing is why uploads are requested as a batch. The
JPEG wins as the preview source; the RAF path only runs for RAW-only photos. The
batch is capped at 200 files in `createUploads`; the admin UI slices to that cap
in `batchFiles` (`RollIndex.tsx`) and issues the slices in parallel. **A basename
group is packed whole**, never split across two calls — a pair that straddles a
slice becomes two photographs with different ids instead of one frame with
`hasRaw`, and nothing afterwards can pair them back up.

`POST /api/uploads` takes **no folder**, and it is the only way a photograph
enters the library. The UI offers it from exactly one place — *Add photos* on the
roll index — so there is never a "which roll did this go to". Frames land with no
membership; filing them is `PUT /api/folders/<id>/photos`, the same route *Add to
roll…* uses. The upload flow offers that as a dialog when the uploads finish —
`requestUploads` already returned the ids, so filing needs no trip through All
photos. Declining is a first-class answer and lands on *All photos*, which is
where the frames are either way.

Attach and detach carry **no batch cap**: each is one transaction and touches no
S3. The old move route was capped at ten because every photo cost a transaction
plus two `CopyObject`s against a 15-second timeout.

`DELETE /api/folders/<id>` never refuses. It cascades the folder's memberships and
its shares, and every photograph survives in the library. Nothing guards it,
because nothing it touches is a photograph.

`photoCount` is bumped inside the same transaction as the membership, so a roll
can never claim a number its member list denies. `createUploads` does not bump it
separately.

Share tokens are stored SHA-256 hashed. `getShare` checks expiry in code because
DynamoDB TTL deletion can lag up to 48 hours — which is also why the admin's share
list greys expired links rather than hiding them: they are really still there. The
list route strips `tokenHash` down to a 12-hex `id` and no route can return a share
URL a second time, so the UI has to say that rather than look like it lost one.

A share with **no `expiresAt` at all never expires** — TTL only deletes items
carrying the attribute, so absence is both "no TTL" and, in `getShare`, no expiry
check. `expiresInDays: 0` creates one. Revoking is then the only thing that ends
it, so treat `Share.expiresAt` as optional everywhere and never `<=`-compare it
without a presence check.

`views` / `lastViewedAt` are bumped by `recordShareView` in **`openShare` only** —
never in `GET /s/<token>` or its `og.webp`, which are what a chat client
prefetches to unfurl a link and would count opens for a message nobody clicked.
They are page loads, not people: a reload counts again. Images are served
straight from CloudFront, so nothing counts a photo view and nothing can without
putting compute in the image path.

## Derivatives

| Input | Preview source |
|---|---|
| JPEG / PNG | `sharp` directly |
| HEIC / HIF | `libheif-js` wasm decode → `sharp` |
| Fujifilm RAF | embedded JPEG, via two S3 range requests |
| Other RAW | stored, no preview unless a JPEG sibling exists |

RAF header: byte 84 is the embedded JPEG's offset, byte 88 its length, both
big-endian `uint32`. Verified on an X-T30 III: a 5.1 MB preview inside a 30.5 MB
file, so the Lambda never downloads the whole RAF or touches Bayer data.

**This path is unverified in production** — every RAF on the current card has a
JPEG sibling, so it has only ever run locally.

## Working on the frontend

`npm run dev --workspace web` works against the deployed stack: `vite.config.ts`
proxies `/api` and `/f` to it and rewrites the image cookie's domain to localhost,
which is the only way those cookies survive the hop. Open a real `/s/<token>` to
work on the share view.

Test the lightbox at full derivative size (400 / 2400). A downscaled stand-in is
what hid the `max-height` bug the landmines list names.

**`RollView`'s pending-frame poll has a ceiling and must keep one** —
`usePendingPoll`, `POLL_ROUNDS` × `POLL_MS`, two minutes. It re-reads the whole library each round,
so a frame that can never develop turned an open tab into ~900 `listLibrary`
calls an hour: at 835 frames that is roughly the entire gallery's monthly cost
per day, and most of the Lambda free tier the rest of the app shares. When it
lapses the sheet says so and offers *Check again* rather than a spinner that
lies, and `ContactSheet` flips the cell from DEVELOPING to STUCK at the same
two minutes, off `uploadedAt`.

`/s/<token>` is the only client-side route. `App.tsx` matches it before touching
Cognito, so a share viewer never loads the auth path; everything else is the admin
UI behind sign-in.

`Admin.tsx` is a shell and holds only the folder list and which roll is open
(`location.hash`, read through `useSyncExternalStore`). Everything else belongs
to one of two views it picks between — `RollIndex` (the roll tiles, sign-out, and
the app's only upload) or `RollView` (one contact sheet), with `SharePanel` and
`SelectionBar` under the latter. **`RollView` is mounted per roll** —
`key={folderId}` — so leaving a roll throws its sheet, selection, open frame and
status line away instead of unsetting them one at a time; there is no
folder-changed reset effect to keep in step with the state it resets.

The admin is folder-first with **All photos** as the first entry in the roll list.
That entry is a pseudo-roll: `LIBRARY_ID` (`'all'`) is not a folder id the server
knows, so `Admin.tsx` synthesises a `FolderView` for it and `isLibrary` gates
everything a real roll has and it doesn't — rename, share, cover, delete roll, and
Remove from roll. *Add to roll* works from both. Upload is on neither: it lives on
the roll index, above both of them, because a frame arrives in the library.

**The filter row is All photos only** (`SheetFilters`, predicates in
`components/filters.ts`). Filename, camera, month, *has RAW* and *undeveloped* are
pure client-side passes over `photos` — the library payload already carries every
field, so none of them costs a byte. *In no roll* is the one exception and the
reason `GET /api/memberships` exists; its checkbox stays **disabled until the
memberships land**, because with an absent map every frame reads as unfiled and the
whole library would flash up as the answer.

The filtered list is `visible`, and it is what `EdgeHeader`, `ContactSheet` and
`Lightbox` all receive — so frame numbers run one-based over what is printed on the
sheet, which is how a contact sheet works. `SelectionBar` gets the **unfiltered**
`photos` instead: a selection survives a filter change, and the bar has to resolve
a selected id that is currently hidden. Filters live in `RollView` state and die
with it, since `RollView` is mounted per roll.

An empty sheet has two meanings and `EmptySheet` keeps them apart: filters that
exclude everything must not render as "No photos yet" over a full library.

**Throwing a photograph away is an All photos action only.** A roll offers
"Remove from roll"; All photos offers "Move to trash" — never both, in the
selection bar or in the lightbox. Inside a roll "get rid of this" nearly always
means "take it out of this roll"; from All photos there is no roll it could have
meant instead. Neither one loses a negative now, so neither is safelight red;
both confirm, because both take a frame out of rolls it was in.

**Trash is the second pseudo-roll**, beside *All photos* in the roll list and on
the same terms — `TRASH_ID` (`'trash'`) is not a folder id the server knows, and
`Admin.tsx` synthesises a `FolderView` for it. `RollView` gates on `isRoll`
(`!isLibrary && !isTrash`) for everything only a real roll has: rename, note,
sort order, share, delete roll. The trash reads `/api/trash`, applies no
filters, keeps its thrown-away order, and does not poll for pending frames —
nothing in the bin is developing. Its `SelectionBar` returns early with two
buttons of its own: *Restore*, and *Destroy permanently* in safelight red. That
red is now the only one in the app that can lose a photograph.

Every question the admin asks goes through `useDialog()`
(`components/Dialog.tsx`) — a native `<dialog>` + `showModal()`, so the focus
trap, Esc and the top layer come from the platform and it needs no z-index to
sit over the lightbox. No `window.confirm`/`prompt` anywhere: they cannot be
styled, and — the part that bit — a `showModal()` dialog does *not* stop keydown
reaching window listeners the way `confirm()` froze the page, so the window
handlers (`Lightbox`'s arrows, `useSelection`'s Escape) check `modalOpen()` or
one Escape cancels the dialog *and* clears the selection under it.

The lightbox is a `<dialog>` too, which is why `modalOpen()` matches
`dialog.modal[open]` and not every open dialog — it must not report *itself* as
the thing holding the keyboard, or its own arrow keys sit behind that check. It
never closes itself directly: the button calls `close()`, and a single `close`
listener is what tells React, so Esc, the button and the backdrop all leave the
same way. Its CSS undoes the UA's dialog box — border, padding, auto margins and
a `fit-content` size that would otherwise shrink the overlay to the image.

**Getting *into* a selection is not a `SelectionBar` job** — the bar only exists
once something is selected. The checkmark on a cell is the way in, *Select all* is
in `RollView`'s toolbar beside *All rolls*, and it takes `visible` rather than
`photos`: it selects what is printed on the sheet. Shift-click ranges from the
last frame toggled, and it only ever **adds** — the anchor is wherever the last
click landed, so a range that could also deselect would make one gesture mean two
things. `ContactSheet` passes the sheet's ids as `order` on a shift-click only, so
`useSelection` never has to know what is on the sheet.

Selection actions live in `SelectionBar` (`.toolbar-footer`), a sticky bar at the
foot of the sheet, not in the roll toolbar — they act on the selection, not the
roll. `batching` is owned by `RollView` and passed down, so the roll toolbar
greys out with the bar: leaving the roll mid-delete is not on offer. It is
sticky rather than fixed so it reserves its own space and cannot cover the last
row, which is why `#root` is `min-height: 100%` and not `height`: a sticky
element is clamped to its containing block, and a 100vh-tall root would let the
bar scroll away.

The web bundle holds no account-specific values: CDK writes `config.json` into the
bucket at deploy time via `Source.jsonData`, and `loadConfig()` fetches it at
startup. Moving pool IDs or the domain into `VITE_` env vars would put them back in
the bundle and make every redeploy a rebuild.

Port 5173 is not just a vite default here — `http://localhost:5173` is allow-listed
in both the bucket's CORS rule and the HTTP API's `corsPreflight` in
`phosto-stack.ts`, which is what lets `vite dev` talk to the deployed API. Changing
the dev port means changing both.

Design direction is a **contact sheet under a darkroom safelight**: uniform 3:2
cells, frame numbers, a folder header set like film edge-printing. Amber
(`--amber`) means negatives/RAW and nothing else; safelight red (`--safelight`) is
destructive actions only. Keep accents doing exactly one job.

## Importing

Through the admin UI only — *Add photos* on the roll index, which is the single
code path that can create a photograph. A card of any size goes in one gesture:
the client slices it into 200-file calls (see `batchFiles` above).

Before a byte moves it compares the picked filenames' stems against the
library's basenames and warns if any already exist. A name match is a **hint,
not a fact** — two cards can both hold `DSCF0001` — so it confirms rather than
refuses. Nothing detects a true duplicate: that would need content hashing or an
index on `basename`, and the realistic mistake is the same card mounted twice,
which the name check catches. Getting it wrong costs ~8.6 GB, or about $0.20/month
forever, for bytes nobody wants.

## Operational notes

- Re-trigger derivatives by copying an object onto itself with
  `--metadata-directive REPLACE`.
- Bucket and table are `RemovalPolicy.RETAIN`. `cdk destroy` will not take the
  library with it.
- Creating the Cognito admin user is a manual step (`admin-create-user`). First
  sign-in hits the `newPasswordRequired` challenge, which `SignIn.tsx` handles.
- Never commit `infra/config.json` or `infra/cdk.context.json` — both embed the
  account ID and the repo is public.
