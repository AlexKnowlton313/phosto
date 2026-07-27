import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const cloudfront = new CloudFrontClient({});
const ssm = new SSMClient({});

/** Set by the stack. Its *name* is a literal; see the comment on the parameter. */
const DISTRIBUTION_ID_PARAM = '/phosto/distribution-id';

/** Cached per container, like the signing key, and never cached as a rejection. */
let distributionIdPromise: Promise<string> | undefined;

function loadDistributionId(): Promise<string> {
  distributionIdPromise ??= ssm
    .send(new GetParameterCommand({ Name: DISTRIBUTION_ID_PARAM }))
    .then((res) => {
      const value = res.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${DISTRIBUTION_ID_PARAM} is empty`);
      return value;
    })
    .catch((err) => {
      distributionIdPromise = undefined;
      throw err;
    });
  return distributionIdPromise;
}

/**
 * Drops paths from the edge cache.
 *
 * Derivatives are written `immutable, max-age=1y`, so deleting the object at the
 * origin does not stop a POP serving the copy it already has to anyone holding a
 * still-valid signed URL for it. Same for a share preview, which is served with
 * no credential at all.
 *
 * Best-effort by design. The caller has already removed the bytes, which is the
 * durable half of the change, and failing the request afterwards would leave the
 * operator with an error on an operation that mostly succeeded. Failures are
 * logged loudly instead.
 *
 * What this cannot reach is the viewer's own browser cache — `immutable` means
 * their tab may never revalidate.
 */
export async function invalidate(paths: string[]): Promise<void> {
  if (!paths.length) return;

  try {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: await loadDistributionId(),
        InvalidationBatch: {
          // Unique per call: CloudFront treats a repeated reference as the same
          // request and returns the original, so a fixed value would silently
          // skip every invalidation after the first.
          CallerReference: `phosto-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    );
  } catch (err) {
    console.error('Invalidation failed; edge may still serve these', { paths, err });
  }
}
