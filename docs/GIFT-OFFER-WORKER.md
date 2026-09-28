# The gift offer behind the Cloudflare Worker

`lib/lp-aboard.ts` serves the public gift-offer page `/lp/aboard` and its claim endpoint.
It is the only PUBLIC part of the portal. Everything else in `server.ts` sits behind the
password gate; the retargeting audience arriving here has no login, so `server.ts` routes
`/lp/*` before the auth check on purpose (`docs/PUBLIC-ROUTES.md`).

No Shopify and no Brevo calls happen here. Submissions land in a JSONL file on the
persistent volume and a separate process (Bengt, via Brevo) reads it. The files
themselves are in `lib/lp-aboard-store.ts`, and the authenticated routes the emailer reads
them through are in `lib/lp-aboard-admin.ts`.

## How the public URL reaches this service

The paths this service knows are UPSTREAM paths. The public URL is
https://nordicpirates.com/gift-offer and the Cloudflare Worker rewrites it onto this
service:

| browser asks for             | Worker sends us               |
|------------------------------|-------------------------------|
| `/gift-offer`                | `/lp/aboard`                  |
| `/gift-offer/style.css`      | `/lp/aboard/style.css`        |
| `/gift-offer/page.js`        | `/lp/aboard/page.js`          |
| `/gift-offer/cart.js`        | `/lp/aboard/cart.js`          |
| `/gift-offer/offer.js`       | `/lp/aboard/offer.js`         |
| `/gift-offer/i18n.js`        | `/lp/aboard/i18n.js`          |
| `/gift-offer/i18n-<lang>.js` | `/lp/aboard/i18n-<lang>.js`   |
| `/gift-offer/media/<file>`   | `/lp/aboard/media/<file>`     |
| `POST /gift-offer/claim`     | `POST /lp/aboard/claim`       |

So every path the PAGE emits is `/gift-offer/...` and every path `lib/lp-aboard.ts` knows
is `/lp/aboard/...`. They are meant to differ. `page.js` imports `"./offer.js"` and
`"./cart.js"`, which the browser resolves against `/gift-offer/page.js` and therefore asks
for as `/gift-offer/offer.js` and `/gift-offer/cart.js`, which land here as
`/lp/aboard/offer.js` and `/lp/aboard/cart.js`.

## Which forwarded headers are believed, and only with the secret

The pretty URL reaches this service through the Worker. On that hop the CF headers
describe the Worker, not the person, so the Worker forwards the real visitor as
`x-visitor-ip` and `x-visitor-country`.

Those headers are just headers: anyone who can reach this origin directly can send them.
Believed unconditionally they would hand an attacker a new identity per request - past the
rate limit, past the Europe check, and straight into the signup file. So they are believed
ONLY when the request also carries the shared secret the Worker holds, in
`x-lp-proxy-secret`. No secret, wrong secret, or no `LP_PROXY_SECRET` configured on this
side means the forwarded headers are ignored entirely.

**Fails closed on purpose: an unset `LP_PROXY_SECRET` trusts nothing.** When it is unset,
the module logs at startup that EVERY claim will be refused with 403 and no codes will be
issued, that the page itself still serves, and that the secret must be set here and on the
Worker before routing nordicpirates.com/gift-offer at this service.

**The secret is read on every claim, never frozen at import.** `proxySecret()` reads
`LP_PROXY_SECRET` each time `proxyIsTrusted` runs. A value captured once at import belonged
to whoever imported the module first: in one `bun test` run every test file shares one
module cache, so a file that imported this module before another file set the secret left
every claim in the run refused. Reading it per claim changes nothing in production, where
the environment is fixed for the life of the process, and an unset or emptied secret still
matches nothing. The startup warning still reads it once, at import, because that is when
an operator starting the service needs to hear it. `tests/lp-aboard-secret.test.ts`
starts the real server with the secret unset and checks both the refusals and the warning.

## The claim endpoint refuses anything that is not the Worker

The claim endpoint is reachable only through the Cloudflare Worker, so `handleClaim`
refuses anything that cannot prove it came from there, with a 403 and the log line
`claim rejected reason=unauthenticated`. Nothing is parsed, nothing is stored, and no code
is handed out until the secret checks out.

Failing closed here rather than falling back to the CF headers is the whole point: at the
origin those are just headers, and believing them would let anyone who can reach this host
pick their own country and their own identity per request. An unset `LP_PROXY_SECRET`
matches nothing, so an unconfigured deploy issues no codes at all rather than issuing
them to everybody.

## `proxyIsTrusted` and `lib/secret.ts`

`proxyIsTrusted` is true when the request proved it came through our Worker. The
comparison itself lives in `lib/secret.ts`, because the emailer's door in
`lib/lp-aboard-admin.ts` checks its own secret exactly the same way, and two copies of a
constant-time compare is one copy too many.

## `clientIp` and `clientCountry`: the Worker's headers and nothing else

Both are only ever called after the secret has been checked, so they read the Worker's
headers and nothing else. There is deliberately no fallback to `CF-Connecting-IP`,
`X-Forwarded-For` or `CF-IPCountry`: those are set by whoever can reach this origin, and a
claim decision must not rest on them.

An authenticated request that forwarded no `x-visitor-ip` is a broken Worker, not a
visitor. It is logged, and everyone in that state lands in one rate-limit bucket
(`"unknown"`) until the Worker is fixed, which is the safe way round.
