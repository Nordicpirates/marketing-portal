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

## One reader: `configuredSecret` in `lib/secret.ts`

Both doors read their configured value the same way, through `configuredSecret(name)`,
which returns the trimmed value of that environment variable at the moment it is called.
`lib/lp-aboard.ts` calls `configuredSecret("LP_PROXY_SECRET")` on every claim and
`lib/lp-aboard-admin.ts` calls `configuredSecret("LP_ADMIN_SECRET")` on every request. No
module keeps a secret in a constant.

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
as the empty string, which `secretMatches` never accepts: both doors still fail closed.

## The startup warnings

Each module still reads its secret once at import, only to warn: when it is unset, the log
says every request to that door will be refused with 403. That read decides nothing. An
operator starting the service is the one who needs to hear it, and startup is when they
are looking.

`tests/lp-aboard-secret.test.ts` checks all of it: the reader itself, the real server with
both secrets unset (every claim and both emailer routes answer 403, both warnings are
logged), and in process that a secret set after import is honoured and one removed after
import refuses, on both doors.
