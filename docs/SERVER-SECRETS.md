# The server-to-server secrets

Two doors in this service open only for a caller that presents a shared secret:

| Door | Header | Configured by | Proves |
|---|---|---|---|
| The gift claim, `lib/lp-aboard.ts` | `x-lp-proxy-secret` | `LP_PROXY_SECRET` | the request came through our Cloudflare Worker |
| The emailer's routes, `lib/lp-aboard-admin.ts` | `x-lp-admin-secret` | `LP_ADMIN_SECRET` | the caller is the emailer |

## Two secrets on purpose

`LP_ADMIN_SECRET` is a different secret from `LP_PROXY_SECRET` on purpose. The proxy
secret says "this request came through our Cloudflare Worker" and is held by an edge
script that talks to the public internet. The admin secret says "this is the emailer" and
unlocks the email addresses. One secret for both would mean a leak at the edge also
empties the signup list. The emailer's routes therefore refuse the Worker's header name
too: that secret only proves a request came through the edge, it is not permission to
read everybody's email address.

## One comparison: `secretMatches` in `lib/secret.ts`

Both doors compare the presented secret with `secretMatches`, a constant-time shared
secret check. Two copies of a constant-time compare is one copy too many.

Both sides are hashed first, so the comparison is always over two 32 byte buffers.
`timingSafeEqual` throws on a length mismatch, and calling it on the raw strings would
both leak the secret's length and turn a wrong-length guess into a different, faster
answer than a wrong-value guess.

An empty configured secret matches nothing, and so does an empty presented one, so a
service that was deployed without a secret refuses everybody instead of letting everybody
in.

## Reading the configured value

`lib/lp-aboard.ts` reads `LP_PROXY_SECRET` on every claim, through `proxySecret()`.
`lib/lp-aboard-admin.ts` reads `LP_ADMIN_SECRET` once, when the module is imported.
Each module logs a warning at startup when its secret is unset, saying every request to
its door will be refused with 403.
