# phosto

A self-hosted photo gallery on AWS. Folders, unlisted share links, and RAW files
that stay out of sight until you ask for them.

Built for a Fujifilm workflow where every shot is a JPEG + RAF pair, but the RAF is
only interesting to about three people.

- **~$0.29/month** for an 18 GB library — see [docs/cost-estimate.md](docs/cost-estimate.md)
- Nothing is publicly readable; every photo byte is behind a CloudFront signature
- RAWs sit in a separate prefix that share links structurally cannot reach

## How it works

Browser uploads straight to S3 via presigned URLs. An S3 event fires a Lambda that
generates `thumb` / `medium` / `large` WebP derivatives — including from Fujifilm
RAF files, by extracting the embedded JPEG with two range requests instead of
downloading 30 MB. The gallery only ever loads derivatives; originals and RAWs need
an explicit click.

See [docs/architecture.md](docs/architecture.md) for the full picture.

## Layout

```
infra/      AWS CDK stack (S3, CloudFront, DynamoDB, Cognito, API Gateway, Lambda)
functions/  api handler + derivative generator
web/        Vite + React admin UI and public share view
scripts/    key bootstrap, bulk uploader for an existing library
docs/       architecture and cost notes
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

## Importing an existing library

The bulk uploader pairs JPEG and RAW by basename, skips macOS `._` sidecar files,
and uses multipart uploads with a resumable state file.

```bash
npm run upload -- --folder "Summer 2026" --src /Volumes/Untitled/DCIM/100_FUJI
```

## Development

```bash
npm run diff        # cdk diff
npm run typecheck
npm run build:web
```

## License

MIT
