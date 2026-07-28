# Staying signed in: the eight-hour cliff

## What is missing

Two credentials expire at eight hours and neither renews itself while the tab is
open.

**The access token.** `App.tsx` calls `currentToken(config)` once, on mount, and
hands the resulting *string* to `<Admin token={token}>`, which binds it into
`adminApi(token)`. `currentToken` refreshes silently through
`user.getSession()` — but nothing calls it again. `accessTokenValidity` is 8
hours (`phosto-stack.ts`), so a tab left open overnight has a dead token in a
closure, and every admin request comes back `401 Invalid or expired token`.
That surfaces as the roll's error line, over an otherwise normal-looking sheet.

**The image cookie.** `startSession` mints signed cookies for `f/*` with
`SESSION_TTL` of 8 hours, once, in the same mount effect. When it lapses,
CloudFront refuses the derivatives and the sheet fills with broken images — and
because there are deliberately no distribution-wide `errorResponses`, those
refusals are honest 403s with no HTML fallback, so there is nothing to
distinguish "expired" from "broken" on screen.

The recovery for both is a manual reload, which the user has to *guess* at.

## Why it matters here

The refresh token is valid for 30 days and `getSession()` already uses it
transparently. The machinery is present; it is called once instead of when
needed.

## The lazy design

**1. Pass the function, not the string.** `adminApi` takes
`getToken: () => Promise<string | null>` instead of `token: string`, and
`request()` awaits it per call. `currentToken` reads local storage and only
touches Cognito when the token has actually expired, so this is a memory read on
almost every call and a silent refresh on the one that matters. The retry-on-401
logic that would otherwise be needed does not have to exist at all.

The `token` prop is still what `Admin`'s effects key on, so nothing else moves.

**2. Renew the cookie on a timer.** In `Admin`, one interval at half of
`SESSION_TTL`:

```ts
// The cookie is what CloudFront reads on every image request; it expires on
// its own clock, not on the JWT's.
useEffect(() => {
  const id = setInterval(() => void api.startSession().catch(() => {}), 4 * 3600_000);
  return () => clearInterval(id);
}, [/* token */]);
```

Swallowed on failure deliberately — a failed renewal must not take down a
working page, and the next tick tries again.

**3. Say so when it still fails.** If a request comes back 401 after the token
function has had its go, the session is genuinely over: render the sign-in view
rather than an error string. `App` already has that branch; it just needs a way
to be told, which is one `onExpired` callback threaded from `request()`.

## Cost

One extra Lambda invocation per open tab per four hours. At a single admin that
is ~180 invocations a month against a 1,000,000 free-tier allowance.

## Skipped

Sliding session windows, a service worker, and any attempt to detect a 403 on an
`<img>` and re-mint mid-flight. Renewing on a timer at half the TTL means the
image credential is never within four hours of expiring while a tab is alive,
which is enough.
