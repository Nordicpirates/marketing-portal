# What the emailer route tests pin, and why

`tests/lp-aboard-admin.test.ts` tests the emailer's two routes, the authenticated signup
reader and the sent ledger (`docs/GIFT-EMAIL-ROUTES.md`). They come straight off the
acceptance criteria written when those routes were built for the emailer.

## Handlers, not a server

The handlers are called directly with `Request` objects. No server is started, except for
one child process that checks what an unset `LP_ADMIN_SECRET` does in a fresh process.

## The store is shared with other files

`bun test` shares one module cache across test files, so the first test file to import
`lib/state-dir.ts` fixes `STATE_DIR` for the whole run. Which file that is depends on the
order bun happens to load them in. So this file never assumes the store is empty, never
assumes it owns it, and asks the store module where its files are instead of rebuilding
the paths from a scratch dir. Every assertion is about rows this file wrote, found by
their own event ids.

## Setting the secret

The emailer's shared secret is set once, in `beforeAll`. The module reads it on every
request through `configuredSecret` (`docs/SERVER-SECRETS.md`), so what matters is the
value while these tests run, not which file imported the module first. It used to be set
twice, at the top of the file and again in `beforeAll`, because the module froze it at
import.

## Everything that is not the emailer is refused

The refusal table is the same as the claim endpoint's: no secret, a wrong one, a near
miss on length, an empty one. Plus the Worker's header name, which must not open this
door: that secret only proves a request came through the edge, it is not permission to
read everybody's email address.

## An unset secret refuses everybody

A child process with no `LP_ADMIN_SECRET` in its environment is the real unconfigured
deploy: it imports the module fresh, so it also shows the startup warning, which is only
printed at import. That a secret set or removed after import is honoured on the next
request is checked in process by `tests/lp-aboard-secret.test.ts`.

## A broken line in the store is reported

Nothing writes a half line today, but a full disk could. The emailer must be told the file
has a line nobody can read rather than being handed a short list that looks complete. The
test puts the store back exactly as it was afterwards, because the claim tests share this
file and parse every line of it, so a half line left behind would fail them instead.
