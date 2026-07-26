# phosto

Self-hosted photo gallery on AWS. Folders, unlisted share links, RAW files hidden
behind a toggle. Live at `photos.alex-knowlton.com`, single admin, ~$0.20/month.

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
npm run typecheck                  # all three workspaces
npm run build:web
npm run diff                       # cdk diff
npm run deploy                     # layer + web build + cdk deploy
```

Deploying needs `infra/config.json` (gitignored — copy `config.example.json`) and
`infra/keys/cloudfront-public.pem` from `npm run bootstrap:keys`.

`--require-approval broadening` fails without a TTY. Non-interactive deploys need
`npx cdk deploy --require-approval never`, after reading the IAM diff.

## The three prefixes

This is the most important thing to understand before changing anything.

```
f/<folderId>/<photoId>/{thumb,medium,large}.webp   derivatives — signed COOKIES
orig/<folderId>/<photoId>.<ext>                    originals   — signed URL, per object
raw/<folderId>/<photoId>.<ext>                     RAW         — signed URL, per object
```

They are separate for two independent reasons, and collapsing them breaks both:

1. **Sharing is enforced structurally, not by API logic.** A share cookie is scoped
   to `f/<folderId>/*`, so it *cannot* reach an original or a RAW no matter how the
   API behaves. Downloads are one-off signed URLs gated on `allowDownload` /
   `allowRaw`.
2. **The derive Lambda listens on `orig/` and `raw/` and writes to `f/`.** Sharing a
   prefix between input and output would make every write retrigger the function.

Verify access control with a canary rather than by reading the config: upload an
object with known bytes under `f/` and confirm an unsigned fetch does not return
them.

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
- **`vite.config.ts` needs `define: { global: 'globalThis' }`** for
  `amazon-cognito-identity-js`, which otherwise builds clean and throws at runtime.

## Data model

DynamoDB single table. Photo sort keys use `uploadedAt`, **not** `takenAt` — the
derive Lambda corrects `takenAt` from EXIF, and a sort key cannot be updated in
place. Callers sort by `takenAt` after reading.

A JPEG and a RAW sharing a basename (`XT300024.JPG` + `.RAF`) are **one** photo
with `hasRaw: true`. That pairing is why uploads are requested as a batch. The
JPEG wins as the preview source; the RAF path only runs for RAW-only photos.

Share tokens are stored SHA-256 hashed. `getShare` checks expiry in code because
DynamoDB TTL deletion can lag up to 48 hours.

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
npm run preview:fixture -- --src /Volumes/Untitled/DCIM/100_FUJI --name "Roll"
```

Then `npm run dev --workspace web` and open `/s/anything`.

Generate fixtures at production derivative sizes (2400px). A smaller fixture is
what hid the lightbox bug.

Design direction is a **contact sheet under a darkroom safelight**: uniform 3:2
cells, frame numbers, a folder header set like film edge-printing. Amber
(`--amber`) means negatives/RAW and nothing else; safelight red (`--safelight`) is
destructive actions only. Keep accents doing exactly one job.

## Importing

```bash
npm run upload -- --folder "Name" --src <dir> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
```

Talks to S3/DynamoDB directly rather than through the API. Resumable via
`scripts/.upload-state.json`, keyed per folder. `--dry-run` first — it reports the
pairing and byte totals without uploading.

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
