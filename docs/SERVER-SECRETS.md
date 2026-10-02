# The portal's secrets

Four doors in this service open only for a caller that presents a secret, and all four
read it with `configuredSecret` and compare it with `secretMatches`:

| Door | Presented as | Configured by | Proves |
|---|---|---|---|
| The gift claim, `lib/lp-aboard.ts` | header `x-lp-proxy-secret` | `LP_PROXY_SECRET` | the request came through our Cloudflare Worker |
| The emailer's routes, `lib/lp-aboard-admin.ts` | header `x-lp-admin-secret` | `LP_ADMIN_SECRET` | the caller is the emailer |
| The staff login, `server.ts` | the login form, then the `auth` cookie | `AUTH_PASSWORD` | the caller is staff |
| The QR scan counter, `lib/qr-links.ts` | header `x-qr-hit-secret` | `QR_HIT_SECRET` | the request came from the QR edge on qr.nordicpirates.com |

## Two secrets on purpose

`LP_ADMIN_SECRET` is a different secret from `LP_PROXY_SECRET` on purpose. The proxy
secret says "this request came through our Cloudflare Worker" and is held by an edge
script that talks to the public internet. The admin secret says "this is the emailer" and
unlocks the email addresses. One secret for both would mean a leak at the edge also
empties the signup list. The emailer's routes therefore refuse the Worker's header name
too: that secret only proves a request came through the edge, it is not permission to
read everybody's email address.

## One comparison: `secretMatches` in `lib/secret.ts`

All four doors compare the presented secret with `secretMatches`, a constant-time shared
secret check. Two copies of a constant-time compare is one copy too many.

Both sides are hashed first, so the comparison is always over two 32 byte buffers.
`timingSafeEqual` throws on a length mismatch, and calling it on the raw strings would
both leak the secret's length and turn a wrong-length guess into a different, faster
answer than a wrong-value guess.

An empty configured secret matches nothing, and so does an empty presented one, so a
service that was deployed without a secret refuses everybody instead of letting everybody
in.

## One reader: `configuredSecret` in `lib/secret.ts`

All four doors read their configured value the same way, through
`configuredSecret(name)`, which returns the trimmed value of that environment variable at
the moment it is called. `lib/lp-aboard.ts` calls `configuredSecret("LP_PROXY_SECRET")` on
every claim, `lib/lp-aboard-admin.ts` calls `configuredSecret("LP_ADMIN_SECRET")` on every
request, `lib/qr-links.ts` calls `configuredSecret("QR_HIT_SECRET")` on every scan, and
`server.ts` calls `configuredSecret("AUTH_PASSWORD")` on every login and every cookie check.
No module keeps a secret in a constant.

Why at call time. A value captured when a module is imported belongs to whoever imported
the module first. In one `bun test` run every test file shares one module cache, so a file
that imported a door before another file set its secret decided that secret for the whole
run: that is how the claim tests once failed 31 times in the full suite while passing
alone, and why the emailer route tests used to set their secret twice. Two modules each
reading their own variable their own way is the shape that let it happen twice, so there
is one reader.

Only an own property of `process.env` counts. Bun's `process.env` inherits from
`Object.prototype`, so a plain `process.env[name]` for an UNSET variable would return
whatever something had put on `Object.prototype` under that name. If anything ever
polluted the prototype at runtime, an unconfigured door would then accept a secret the
attacker chose, and reading per request is what would make that reachable. So
`configuredSecret` reads `process.env[name]` only when `Object.hasOwn(process.env, name)`
is true, and anything inherited reads as the empty string.
`tests/lp-aboard-secret.test.ts` pollutes the prototype with both variables unset and
checks that the reader returns "" and that the claim and both emailer routes refuse.

Production does not change. Its environment is fixed for the life of the process, so
reading per request gives the same value every time, and an unset or blank secret reads
as the empty string, which `secretMatches` never accepts: every door still fails closed.

## The startup warnings

Each door still reads its secret once at import, only to warn: when it is unset, the log
says every request to that door will be refused (403 for the two server-to-server doors,
401 for the staff login). That read decides nothing. An operator starting the service is
the one who needs to hear it, and startup is when they are looking.

`tests/lp-aboard-secret.test.ts` checks all of it: the reader itself, the real server with
both secrets unset (every claim and both emailer routes answer 403, both warnings are
logged), and in process that a secret set after import is honoured and one removed after
import refuses, on both doors.

## The staff login

`AUTH_PASSWORD` is the one shared staff password. There is no fallback in the source: with
it unset, empty (`AUTH_PASSWORD=` with nothing after it) or blank, every login answers the
login page with 401, every `auth` cookie is refused, and `server.ts` logs a warning at startup, the same way the two server-to-server
doors warn and refuse. A default password written in the repository would have been a
door that fails open, and because the cookie is derived from the password, knowing the
default would also have meant knowing a valid cookie.

**The login compare is forgiving on purpose.** The typed password is trimmed, and both
sides are lowercased before `secretMatches` compares them, so phone and Mac autocapitals
cannot lock anybody out.

**The cookie is not.** `auth` holds `sha256("np-hq-" + password)` in hex, where `password`
is the configured value, trimmed and NOT lowercased. `checkAuth` recomputes it from the
configured password on every request and compares it with each `auth` value through
`secretMatches`. That derivation, the cookie name and its attributes (`HttpOnly; Secure;
SameSite=Lax; Max-Age=2592000; Path=/`) are exactly what they were before the login moved
onto this door, so a cookie issued before the change is still accepted with the same
password and nobody is signed out. Changing any of them signs every staff member out.

**The Cookie header is parsed, not searched.** `authCookies` splits it into name=value
pairs and keeps only the values of pairs named exactly `auth` that are exactly 64
lowercase hex characters; `checkAuth` accepts the request if ANY of them matches through
`secretMatches`. A search for the first `auth=` followed by 64 hex characters used to
accept `xauth=<token>`, `foo=auth=<token>`, `auth=<token>zz` and `auth=<token>0`. It also
refused `auth=<64 zeros>; auth=<token>`, so a cookie planted from a sibling subdomain,
which the browser sends ahead of the real one, could sign a staff member out. Now it
cannot.

**No token is ever computed from an empty password.** `sha256("np-hq-")` is a constant
anyone can compute, so `checkAuth` refuses outright when no password is configured,
before it hashes anything.

Rate limiting, lockouts and a second factor are not here; they are a separate concern.
`tests/staff-login.test.ts` starts the real server with the password unset, empty, blank
and set, and checks every point above. It also reads `server.ts` and fails if anything
defaults the password: an `||` or `??` after `configuredSecret("AUTH_PASSWORD")`, or any
other read of `process.env.AUTH_PASSWORD`.
