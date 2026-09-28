# Cross-site writes: the guard in front of every portal POST

`crossSiteRefusal` in `server.ts` refuses a state-changing request that a browser made on
behalf of another site, or that does not say it is sending JSON. It returns null when the
request may proceed.

## Where it runs: once, in the router

The router calls it exactly once, right after the auth check, for every `POST` whose path
starts with `/api/`. No route calls it for itself. Guarding routes one at a time is how
`POST /api/tasks` was missed while `/api/ideas` and `/api/shipments` were guarded, and the
next POST route would be missed the same way. Being in the router, it also covers a POST
to a read-only path such as `/api/data`: that answers 403 or 415 the same way.

Auth runs first, so a request with no valid cookie is answered 401 before any 403 or 415.

POST only, deliberately. It is the only state-changing method a browser can send
cross-origin without a preflight. PUT, PATCH and DELETE are always preflighted, and nothing
here answers OPTIONS, so a browser never sends them cross-origin. A PUT or DELETE on
`/api/ideas` or `/api/shipments` still reaches the route and gets its 405.

## The gap this closes, and why the cookie alone does not

SameSite=Lax keeps the cookie off a cross-SITE request, whether that is a form post or a
fetch, so a page on an unrelated domain never had the cookie to begin with. What Lax does
not stop is a same-site, cross-ORIGIN request: a page on a sibling subdomain is same-site
with this portal, so the cookie rides along. Sending `Content-Type: text/plain` from there
is a "simple" request, so there is no preflight to fail either, and our `JSON.parse` reads
the body happily. The two checks below are what close that gap.

## Which of the two checks is load bearing, stated plainly

**Requiring `application/json` is.** It is not a CORS-simple content type, so a
cross-origin fetch that sets it must be preflighted, and nothing here answers OPTIONS with
CORS headers, so the browser never sends the real request. That holds without trusting a
single header value. Do not add an OPTIONS handler. A request without it is refused with
415.

**The Origin comparison is defence in depth, and only against a browser.** Every value it
weighs comes from the request itself: the Origin being judged, and all three names it is
judged against (`Host`, `X-Forwarded-Host` and `Forwarded`), plus `Sec-Fetch-Site`.
Nothing here is pinned to a value this server knows independently, so any client that can
set its own headers, meaning anything that is not a browser, satisfies it trivially. It
is worth keeping because a browser cannot set any of them from script, and a browser is
exactly the attacker this endpoint has: a page on a sibling subdomain whose fetch carries
the cookie. It is not an authorisation check and must not be read as one. Pinning the
host would make it one, and is deliberately not done here. A mismatch is refused with 403.

`Sec-Fetch-Site: same-origin` is accepted on its own for the same reason: a browser sets
it and script cannot. It is the way through when a proxy rewrites `Host` to something
internal and forwards nothing, where no host comparison could ever succeed. Only
same-origin, because same-site is exactly the sibling-subdomain case being refused.

No Origin at all is allowed through, so a server-to-server caller is unaffected.

## Host matching: `bareHost`

`bareHost` turns one host name into the single spelling the URL parser gives it, so that
two spellings of the same host compare equal.

Everything goes through the parser rather than through string slicing, because slicing
normalises less than the parser does and the two sides of the comparison would then
disagree about the same host. The parser collapses IPv6 (`[0:0:0:0:0:0:0:1]` and `[::1]`
are one host), converts an international name to its A-label (`münchen.de` and
`xn--mnchen-3ya.de` are one host), lowercases, and drops the port. Hand-written slicing got
none of those right, and each one of them was a 403 for a request that genuinely came
from the portal.

Dropping the port means a different port on the SAME host name counts as ours. That is
the deliberate trade: a live deployment terminates TLS in front of this process, so the
port seen here is never the port the browser used, and no comparison that keeps it can be
right. Different host names, which is what a hostile page actually has, still differ.

One trailing dot is stripped after parsing. A fully qualified name ends in a dot and is
the same DNS name without it, but the parser keeps it
(`new URL("http://marketing.nordicpirate.com./").hostname` is
`"marketing.nordicpirate.com."`), and the live proxy serves that spelling. Without the
strip, `X-Forwarded-Host: marketing.nordicpirate.com.` against
`Origin: https://marketing.nordicpirate.com` was a 403. A genuinely different host, with
or without the dot, still differs.

A proxy chain arrives as `first, second`; the first entry is the one the client used. A
value that is not a host at all becomes `""`, which never matches anything.

## The `Forwarded` header: `forwardedHost`

`forwardedHost` reads the `host` parameter of an RFC 7239 `Forwarded` header, if there is
one. The parameter name is anchored to the start of the header or to a semicolon, so only
a real `host=` token matches. Without that anchor any parameter whose name merely ENDS in
host counted, and `proto=https;xhost=evil.com` was read as a host of `evil.com`.

## What not to change

- Do not add CORS headers or an OPTIONS handler: the missing preflight answer is the
  load-bearing half.
- Do not change the cookie's SameSite value to fix a cross-site gap. That is a much wider
  blast radius and signs people out.
