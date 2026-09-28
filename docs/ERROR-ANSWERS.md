# What the portal answers when something goes wrong

The rule: no request may end in an unhandled throw. Bun answers one itself, and what it
says is not ours to control. Every failure below is answered with one plain sentence, and
the detail goes to the log, where an operator can read it.

## Why an unhandled throw is never acceptable: `development: false`

Bun decides whether to show its development error page from NODE_ENV, and nothing in this
repo sets NODE_ENV, so an unhandled throw anywhere in the server would be answered with
Bun's development page: absolute paths, the source lines around the throw, and a stack
trace. `Bun.serve` in `server.ts` sets `development: false` so that does not depend on
how the container happened to be started.

## The request body cap: `MAX_REQUEST_BODY_BYTES`

1 MB. Nothing this server accepts is remotely that big: the largest real body is a claim
form with an email address in it. Bun's default ceiling is 128 MB, which on a public
endpoint is a free way to make us hold rubbish in memory.

## A body that is valid JSON but not an object: 400

`null`, `[1,2]`, `"text"` and `7` are all valid JSON, and every one of them used to reach
`addIdea`, where reading `.brand` off `null` threw and answered 500. A malformed body is
the caller's mistake, so the ideas route says so with a 400 and writes nothing.

`POST /api/tasks` had the same hole: a body of `null` reached `body.id` and answered 500.
It now answers its existing 400 (`need id + done`) for `null`, a string, a number or an
array, and writes nothing.

## The ideas store cannot be used: 503, `ideasResponse`

The store throws on purpose rather than reading a file it does not recognise, and an
unhandled throw is answered by Bun itself with a page carrying absolute paths, the source
lines around the throw and a stack trace. That is tens of kilobytes of internals behind
nothing but the staff password. `ideasResponse` says one sentence instead, and says it the
same way whatever NODE_ENV happens to be, so the answer does not depend on how the
container was started.

## Notion said no, or could not be reached: 502, `notionFailure`

Creator shipments live in a Notion database, read and written through `lib/shipments.ts`.
When Notion refuses or cannot be reached while serving the shipments page, one sentence
with Notion's status goes to the caller and to the log; Notion's own body never does,
because it can echo the request back. 502 rather than 500: the fault is upstream, and an
unhandled throw would be answered with Bun's own page.

## Shipments without the Notion key: 503 on write

Without the integration key the shipments page still opens and points at Notion, and a
write is refused with 503 and the Notion link. Nothing on that route throws for a missing
key.
