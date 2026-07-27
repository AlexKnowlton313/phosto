import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedCookies, getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { PREFIX_DERIVED } from './keys.js';

const ssm = new SSMClient({});
const KEY_PAIR_ID = process.env.KEY_PAIR_ID!;
const PRIVATE_KEY_PARAM = process.env.PRIVATE_KEY_PARAM!;
const DOMAIN = process.env.DOMAIN_NAME!;

/**
 * Cached across invocations for the life of the execution environment. The key
 * only changes when it is deliberately rotated, at which point every share link is
 * invalidated anyway and cold starts pick up the new value.
 */
let privateKeyPromise: Promise<string> | undefined;

function loadPrivateKey(): Promise<string> {
  privateKeyPromise ??= ssm
    .send(
      new GetParameterCommand({ Name: PRIVATE_KEY_PARAM, WithDecryption: true }),
    )
    .then((res) => {
      const value = res.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${PRIVATE_KEY_PARAM} is empty`);
      return value;
    })
    .catch((err) => {
      // Don't cache a rejected promise — a transient SSM failure would otherwise
      // poison every subsequent request on this container.
      privateKeyPromise = undefined;
      throw err;
    });

  return privateKeyPromise;
}

type SignedCookies = ReturnType<typeof getSignedCookies>;

/**
 * One set of cookies covering every derivative, issued only to the admin.
 *
 * The resource is `f/*` and nothing else: no folder id appears in a key, so
 * there is no narrower wildcard to sign — a share gets per-object URLs instead.
 * Cookies are scoped with Path=/ because CloudFront matches the policy's
 * Resource, not the cookie path; the policy is what grants access.
 */
export async function signDerivativeCookies(
  ttlSeconds: number,
): Promise<SignedCookies> {
  const privateKey = await loadPrivateKey();
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;

  const policy = JSON.stringify({
    Statement: [
      {
        Resource: `https://${DOMAIN}/${PREFIX_DERIVED}*`,
        Condition: { DateLessThan: { 'AWS:EpochTime': expires } },
      },
    ],
  });

  return getSignedCookies({ keyPairId: KEY_PAIR_ID, privateKey, policy });
}

/**
 * A short-lived URL for one specific object — used for originals and RAWs.
 *
 * Deliberately signs a bare object URL with no query string. An earlier version
 * appended `response-content-disposition` to name the downloaded file, which
 * failed twice over: the canned policy's Resource then includes that parameter,
 * so CloudFront has to match it byte-for-byte against the viewer request and the
 * `+`/`%20` encoding of the space in `attachment; filename=` is enough to fail
 * the signature check (a CloudFront `AccessDenied`, which reads like a key or
 * key-group problem). And it was useless even when it validated, because the
 * signed behaviors use CACHING_OPTIMIZED, whose query-string behavior is `none`
 * — CloudFront strips the parameter before S3 ever sees it. The download name is
 * set by the client instead, via `<a download>`; the app and the objects share an
 * origin, so the attribute is honored.
 */
export async function signObjectUrl(
  key: string,
  ttlSeconds: number,
): Promise<string> {
  const privateKey = await loadPrivateKey();

  return getSignedUrl({
    url: `https://${DOMAIN}/${key}`,
    keyPairId: KEY_PAIR_ID,
    privateKey,
    dateLessThan: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  });
}

export function cookieHeaders(cookies: SignedCookies, maxAge: number): string[] {
  return Object.entries(cookies).map(
    ([name, value]) =>
      `${name}=${value}; Domain=${DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

/** Overwrites the signed cookies with already-expired ones. */
export function clearCookieHeaders(): string[] {
  return ['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id'].map(
    (name) => `${name}=; Domain=${DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}
