# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## phosto

Self-hosted photo gallery on AWS. Folders, unlisted share links, RAW files hidden
behind a toggle. Live at `photos.alex-knowlton.com`, single admin, ~$0.29/month
all-in — of which ~$0.20 is storage once RAW ages into Glacier IR
(`docs/cost-estimate.md`).

## Layout

```
infra/      CDK stack — the single source of truth for all AWS resources
functions/  api (HTTP handler) + derive (S3-triggered image pipeline) + shared/
web/        Vite + React. Admin UI and the public share view
scripts/    key bootstrap, bulk uploader, dev fixture generator
docs/       architecture.md, cost-estimate.md
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
f/<folderId>/<photoId>/{thumb,large}.webp          derivatives — signed COOKIES
f/hidden/<folderId>/<photoId>/{thumb,large}.webp   hidden frames — admin cookie only
orig/<folderId>/<photoId>.<ext>                    originals   — signed URL, per object
raw/<folderId>/<photoId>.<ext>                     RAW         — signed URL, per object
```

They are separate for two independent reasons, and collapsing them breaks both:

1. **Sharing is enforced structurally, not by API logic.** A share cookie is scoped
   to `f/<folderId>/*`, so it *cannot* reach an original or a RAW no matter how the
   API behaves. JPEG downloads are one-off signed URLs gated on `allowDownload`;
   RAW is owner-only and has no share route at all.
2. **The derive Lambda listens on `orig/` and `raw/` and writes to `f/`.** Sharing a
   prefix between input and output would make every write retrigger the function.

Hiding a frame applies the same trick one level down. A share cookie is signed
for `f/<folderId>/*` and the literal `hidden` segment diverges before the
wildcard, so hiding revokes cookies already issued — which a list filter cannot.
`f/hidden/…` still matches the `f/*` CloudFront *behavior* (a path pattern's `*`
crosses `/`), so routing needs no change. Build every derivative key through
`derivedKey(folderId, photoId, name, hidden)`; the flag is on the `Photo` record,
so anything holding the item can read it. Missing it in the derive Lambda
republishes a hidden frame at the visible key on the next re-derive.

**Moving the bytes is only half of it.** Derivatives are written `immutable,
max-age=1y` and `f/*` is on `CACHING_OPTIMIZED`, so a POP that already cached the
visible URL keeps serving it — and reopening the share mints a fresh cookie that
still covers that URL, so the hide achieves nothing at the edge. That is why the
API holds `cloudfront:CreateInvalidation` and calls `invalidate()` after moving
the objects. The distribution id travels through SSM because `Distribution →
HttpApi → ApiFunction` means an env var or an ARN-scoped grant would close a
CloudFormation cycle. What no server-side fix reaches is the viewer's own browser
cache: `immutable` means their open tab may never revalidate. Hiding revokes the
frame for everyone they forwarded the link to, not for the person who already had
it open.

**That reasoning is not specific to hiding, and neither is the code any more.**
Moving a frame out of a shared roll and deleting one leave the same cached copy
behind the same still-valid cookie, so all three removals go through
`deleteObjects()` in `functions/api/index.ts` — never a bare
`DeleteObjectsCommand`. It does two things no caller should repeat: checks
`Errors` in the *response*, because `DeleteObjects` reports per-key failures
there rather than throwing and an unchecked partial delete returns success on a
frame that is still readable; and invalidates, collapsed to one
`/f/<folder>/<photo>/*` wildcard per photo rather than one path per key, which
is what keeps orphaning a 200-frame roll inside CloudFront's free 1000
paths/month.

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
`allowDownload` / `allowRaw` and omits what the caller may not have, so original
and RAW keys never appear in a payload that isn't permitted to fetch them — the API
counterpart to the prefix split above. `openShare` always passes `allowRaw: false`:
shares are JPEG-only by construction, so the admin view is the only place `hasRaw`
is ever true and the only place a Download RAW button appears.

Two credential types come out of this Lambda and they are not interchangeable:
signed **cookies** for derivatives (admin gets `f/*`, a share gets
`f/<folderId>/*`) and single-object signed **URLs** for originals and RAWs. Both
are minted in `functions/shared/signing.ts` from the SSM-held private key, cached
per container but never cached as a rejected promise.

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
- **`/s/*` is not a static route any more.** It has its own CloudFront behavior
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
  plus the patch: no `photoId`, no `basename`, no `folderId`. `listPhotos`
  returns it because the sort key still matches, the grid renders
  `/f/undefined/undefined/thumb.webp`, and `findPhoto` filters on `photoId`, so
  no route can delete it again. It returns `false` instead of throwing —
  the record being gone is a race, not a failure. Derive pairs that with a
  re-read after `writeDerivatives`: a `null` there means deleted *or* moved
  (`pk` carries the folder), and the derivatives it just wrote landed after the
  sweep that was meant to remove them, so it deletes them rather than strand
  them under a prefix no record names.

## Data model

One DynamoDB table, reached only through `functions/shared/db.ts`:

| Item | pk | sk | gsi1pk / gsi1sk |
|---|---|---|---|
| Folder | `FOLDER#<id>` | `META` | `ROOT` / `<createdAt>#<id>` |
| Photo | `FOLDER#<id>` | `PHOTO#<uploadedAt>#<photoId>` | — |
| Share | `SHARE#<sha256>` | `META` | `FOLDER#<id>` / `SHARE#<createdAt>` |

`gsi1` is overloaded: `gsi1pk = ROOT` lists every folder, `gsi1pk = FOLDER#<id>`
lists that folder's shares.

Photo sort keys use `uploadedAt`, **not** `takenAt` — the derive Lambda corrects
`takenAt` from EXIF, and a sort key cannot be updated in place. Callers sort by
`takenAt` after reading. `photoId` is absent from the sort key too, so `findPhoto`
is a filtered query across the folder partition rather than a point read; that is
the first thing that stops scaling.

A JPEG and a RAW sharing a basename (`XT300024.JPG` + `.RAF`) are **one** photo
with `hasRaw: true`. That pairing is why uploads are requested as a batch. The
JPEG wins as the preview source; the RAF path only runs for RAW-only photos. The
batch is capped at 200 files in `createUploads` and the admin UI does not chunk, so
dropping more than that on it fails the whole selection with a 400.

One folder id is a literal rather than a UUID: `orphaned` (`ORPHAN_FOLDER_ID`).
It is created lazily on first use, refuses PATCH of `name` and every DELETE, and
is otherwise an ordinary folder — keys are `f/orphaned/…` like any other. Real
ids come from `randomUUID()`, so the literal cannot collide.

`DELETE /api/folders/<id>` still **refuses** a roll that holds frames; moving
them to `orphaned` first is a client workflow in `deleteRoll`, not something the
route does for you. It refuses twice over: once on the photo count, and again if
any object remains under the folder's three prefixes. The second check is the
one that matters — a move writes the record before it copies the bytes, so a
batch killed mid-flight leaves objects under the old prefix with no record
naming them, and deleting the folder then removes the last handle to a
photograph that is still sitting in the bucket.

Share tokens are stored SHA-256 hashed. `getShare` checks expiry in code because
DynamoDB TTL deletion can lag up to 48 hours — which is also why the admin's share
list greys expired links rather than hiding them: they are really still there. The
list route strips `tokenHash` down to a 12-hex `id` and no route can return a share
URL a second time, so the UI has to say that rather than look like it lost one.

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

No deployed stack needed. The fixture generator writes real derivatives from a
folder of photos, and `vite.config.ts` serves them for any `/api/share/*` request:

```bash
npm run preview:fixture -- --src /Volumes/Untitled/DCIM/100_FUJI --name "Roll" [--limit 24]
```

Then `npm run dev --workspace web` and open `/s/anything`.

`make-preview.mjs` writes at production derivative sizes (400 / 2400) on purpose —
a smaller fixture is what hid the lightbox bug. Don't shrink it to speed the script
up.

`/s/<token>` is the only client-side route. `App.tsx` matches it before touching
Cognito, so a share viewer never loads the auth path; everything else is the admin
UI behind sign-in.

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

```bash
npm run upload -- --folder "Name" --src <dir> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
                  [--dry-run] [--reset]
```

Talks to S3/DynamoDB directly rather than through the API, resolving stack outputs
from CloudFormation. Resumable via `scripts/.upload-state.json`, keyed per folder;
`--reset` discards that state and starts the folder over. `--dry-run` first — it
reports the pairing and byte totals without uploading.

`--since`/`--until` filter on EXIF `DateTimeOriginal`, which carries no timezone
and is deliberately **not** converted: the date means the date where the camera
was.

macOS writes `._NAME` AppleDouble sidecars onto FAT cards — 4 KB of metadata with a
real image extension. They must stay filtered or they upload as corrupt photos.

## Operational notes

- Re-trigger derivatives by copying an object onto itself with
  `--metadata-directive REPLACE`.
- Bucket and table are `RemovalPolicy.RETAIN`. `cdk destroy` will not take the
  library with it.
- Creating the Cognito admin user is a manual step (`admin-create-user`). First
  sign-in hits the `newPasswordRequired` challenge, which `SignIn.tsx` handles.
- Never commit `infra/config.json` or `infra/cdk.context.json` — both embed the
  account ID and the repo is public.
