import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedCookies, getSignedUrl } from '@aws-sdk/cloudfront-signer';

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

export interface SignedCookie {
  name: string;
  value: string;
}

/**
 * Signs a wildcard resource so one set of cookies covers every derivative in a
 * folder. Cookies are scoped with Path=/ because CloudFront matches the policy's
 * Resource, not the cookie path — but the policy itself is what grants access, and
 * it names exactly one folder prefix.
 */
export async function signFolderCookies(
  resource: string,
  ttlSeconds: number,
): Promise<SignedCookie[]> {
  const privateKey = await loadPrivateKey();
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;

  const policy = JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: { DateLessThan: { 'AWS:EpochTime': expires } },
      },
    ],
  });

  const cookies = getSignedCookies({ keyPairId: KEY_PAIR_ID, privateKey, policy });

  return Object.entries(cookies).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

/** A short-lived URL for one specific object — used for originals and RAWs. */
export async function signObjectUrl(
  key: string,
  ttlSeconds: number,
  downloadFilename?: string,
): Promise<string> {
  const privateKey = await loadPrivateKey();
  const url = new URL(`https://${DOMAIN}/${key}`);

  if (downloadFilename) {
    // CloudFront forwards this to S3, which echoes it back as the download name.
    url.searchParams.set(
      'response-content-disposition',
      `attachment; filename="${downloadFilename.replace(/"/g, '')}"`,
    );
  }

  return getSignedUrl({
    url: url.toString(),
    keyPairId: KEY_PAIR_ID,
    privateKey,
    dateLessThan: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  });
}

export function cookieHeaders(cookies: SignedCookie[], maxAge: number): string[] {
  return cookies.map(
    ({ name, value }) =>
      `${name}=${value}; Domain=${DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

/** Overwrites the signed cookies with already-expired ones. */
export function clearCookieHeaders(): string[] {
  return ['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id'].map(
    (name) => `${name}=; Domain=${DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}
