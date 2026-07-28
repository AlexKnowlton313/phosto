# phosto

A self-hosted photo gallery on AWS. Folders, unlisted share links, and RAW files
that stay out of sight until you ask for them.

Built for a Fujifilm workflow where every shot is a JPEG + RAF pair, but the RAF is
only interesting to about three people.

- **~$0.29/month** for an 18 GB library — see [COSTS.md](COSTS.md)
- Nothing is publicly readable; every photo byte is behind a CloudFront signature
- RAWs sit in a separate prefix that share links structurally cannot reach

## How it works

Browser uploads straight to S3 via presigned URLs. An S3 event fires a Lambda that
generates `thumb` / `large` WebP derivatives — including from Fujifilm
RAF files, by extracting the embedded JPEG with two range requests instead of
downloading 30 MB. The gallery only ever loads derivatives; originals and RAWs need
an explicit click.

## Layout

```
infra/      AWS CDK stack (S3, CloudFront, DynamoDB, Cognito, API Gateway, Lambda)
functions/  api handler + derivative generator
web/        Vite + React admin UI and public share view
scripts/    key bootstrap
```

## Setup

Requires Node 20+, an AWS account with credentials configured, and a Route53 hosted
zone for the parent domain.

```bash
npm install
```

Copy the example config and fill in your own domain and account:

```bash
cp infra/config.example.json infra/config.json
```

Bootstrap CDK in the target account and region, once per account:

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

Generate the CloudFront signing key pair. The private key goes to SSM Parameter
Store as a `SecureString`; the public key is needed at synth time.

```bash
npm run bootstrap:keys
```

Deploy. This builds the sharp Lambda layer, builds the web bundle, and pushes the
stack.

```bash
npm run deploy
```

The stack outputs the CloudFront domain, the Cognito user pool ID, and the API URL.
Create your single admin user:

```bash
aws cognito-idp admin-create-user --user-pool-id <POOL_ID> --username you@example.com
```

## Importing photos

Uploads happen in the admin UI, from the roll index — **Add photos**. JPEG and RAW
files with a matching basename (`XT300024.JPG` + `.RAF`) become one frame. Uploaded
frames land in the library and in no roll; file them from **All photos** with *Add
to roll*.

**All photos** filters by filename, camera, month, RAW and — the one that matters
after a card dump — **in no roll**, which is how you find what is still unfiled.

## Development

```bash
npm run diff        # cdk diff
npm run typecheck
npm run build:web
```

The dev server proxies `/api` and `/f` to the deployed stack, so run it against
real data — a real share link included.

```bash
npm run dev --workspace web
```

## License

MIT
