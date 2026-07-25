# Cost estimate

Modelled against a real library: 417 JPEG (5.99 GB), 412 Fujifilm RAF (11.89 GB),
6 HIF (0.05 GB) — 835 files, 17.93 GB. Prices are AWS `us-east-1` public list
prices; verify against the [AWS pricing calculator](https://calculator.aws) before
relying on them, since list prices change.

## The shape of the problem

RAW files are **66% of the bytes and ~0% of the traffic**. Everything below follows
from that: RAWs go to a cheap storage class and are never served through the normal
gallery path, while the gallery serves small derivatives instead of originals.

## Monthly cost

| Scenario | Library | Storage | Requests + compute | Total/mo |
|---|---|---|---|---|
| **Today, RAW → Glacier Instant Retrieval** | 18 GB | $0.20 | $0.09 | **$0.29** |
| Today, RAW → Deep Archive | 18 GB | $0.16 | $0.09 | $0.25 |
| Today, everything S3 Standard | 18 GB | $0.43 | $0.09 | $0.51 |
| 5× growth, light sharing | 90 GB | $1.00 | $0.16 | $1.16 |
| 20× growth, busy sharing | 360 GB | $4.00 | $0.28 | $4.28 |
| 1 TB library | 1 TB | $11.34 | $0.34 | $11.68 |

One-time migration of the existing 18 GB: **~$0.01**. Ingress is free; the cost is
~4,200 PUT requests at $0.005/1,000.

Route53 hosted zone ($0.50/mo) is already being paid for the parent domain. The ACM
certificate is free.

## Unit prices used

| Item | Price |
|---|---|
| S3 Standard | $0.023 /GB-mo |
| S3 Glacier Instant Retrieval | $0.004 /GB-mo (90-day min, $0.03/GB retrieval) |
| S3 Glacier Deep Archive | $0.00099 /GB-mo (180-day min, 12h restore) |
| S3 PUT | $0.005 /1,000 |
| S3 GET | $0.0004 /1,000 |
| CloudFront egress | 1 TB/mo free forever, then $0.085 /GB (NA/EU) |
| CloudFront requests | 10M/mo free forever, then $0.01 /10,000 |
| DynamoDB on-demand | $1.25/M writes, $0.25/M reads, $0.25 /GB-mo |
| Lambda | 1M req + 400k GB-s free/mo, then $0.0000166667 /GB-s |
| Cognito | 10,000 MAU free |

## Why storage class matters here

`raw/` transitions to Glacier Instant Retrieval after 30 days. Retrieval is still
measured in milliseconds, so the "show RAWs" toggle stays instant — you only pay
$0.03/GB on the rare occasion someone actually downloads one.

Deep Archive would save about $0.04/month and cost 12-hour restores. Not worth it.

## The one thing that can blow up the bill

CloudFront egress. The free tier is generous, but serving 14.7 MB originals instead
of derivatives burns through it ~16× faster:

| | GB/mo | Billable | Cost |
|---|---|---|---|
| Derivatives, 3k views/mo | 2.6 | 0 | $0 |
| Derivatives, 500k views/mo | 440 | 0 | $0 |
| **Originals, 500k views/mo** | **7,178** | **6,154** | **$523** |

Mitigations built into the design:

- The gallery only ever loads `thumb` / `medium` / `large` derivatives. Originals
  require an explicit download click.
- `raw/*` and `f/*` both sit behind CloudFront trusted key groups, so neither can be
  hotlinked or crawled without a signature.
- Share tokens carry an expiry, and `allowDownload` / `allowRaw` are off by default.

Set a billing alarm anyway.

## Comparison

| Option | Cost/mo | Notes |
|---|---|---|
| This, today's library | ~$0.29 | Full control, you maintain it |
| SmugMug | ~$13 | Unlimited storage, no maintenance |
| Google Photos 2 TB | ~$10 | No real RAW/derivative separation |
| Cloudflare R2 + Workers | ~$0.27 | Zero egress fees; different ecosystem |
