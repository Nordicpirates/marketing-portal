# What the portal answers when something goes wrong

The rule: no request that reaches the handler may end in an unhandled throw. Bun answers
one itself, and what it says is not ours to control. Every failure listed under the rule
below is answered by us, never by Bun: with one plain sentence, or the login page for a
login, or the rebuilt task list for an unusable tasks file. Each one also puts a line in
the log, where an operator can read it.

## Why an unhandled throw is never acceptable: `development: false`

Bun decides whether to show its development error page from NODE_ENV, and nothing in this
repo sets NODE_ENV, so an unhandled throw anywhere in the server would be answered with
Bun's development page: absolute paths, the source lines around the throw, and a stack
trace. `Bun.serve` in `server.ts` sets `development: false` so that does not depend on
how the container happened to be started. Even then, what Bun sends for a throw is its
own generic 500, not a sentence of ours, so the handler must not throw at all.

## Under the rule

### A body that is valid JSON but not an object: 400

`null`, `[1,2]`, `"text"` and `7` are all valid JSON, and every one of them used to reach
`addIdea`, where reading `.brand` off `null` threw and answered 500. A malformed body is
the caller's mistake, so the ideas route says so with a 400, logs the refusal and writes
nothing.

`POST /api/tasks` had the same hole: a body of `null` reached `body.id` and answered 500.
It now answers its existing 400 (`need id + done`) for `null`, a string, a number, an
array or a body missing `id` or a boolean `done`, logs the refusal, and writes nothing.

### A tasks file that parses but is not a task list

`readTasks` treats a `tasks.json` that does not parse as empty and rebuilds it from the
seed. A file that parses but is not an object holding an `agency_tasks` array (for example
the content `null`) used to throw a TypeError at `cur.agency_tasks` and answer Bun's
generic 500 on every GET and POST. It is now treated exactly like the unparseable file:
empty, rebuilt from the seed. Both cases log one line naming the file, because rebuilding
from the seed resets every done-flag to the seed's value. The merge and what gets stored
are otherwise unchanged.

The committed seed (`data/tasks.json`) is deliberately not guarded the same way: treating
a broken seed as empty would overwrite every stored done-flag, and a 500 does not.

### A login POST that is not a form

`POST /login` read its body with `req.formData()`, which throws for a body that is not a
form (for example `application/json`), and answered a generic 500 to anyone, logged in or
not. It now answers exactly what a wrong password answers, the login page with 401, and
logs one line. The password check, the cookie and every successful login are unchanged.

### The ideas store cannot be used: 503, `ideasResponse`

The store throws on purpose rather than reading a file it does not recognise, and an
unhandled throw is answered by Bun itself with a page carrying absolute paths, the source
lines around the throw and a stack trace. That is tens of kilobytes of internals behind
nothing but the staff password. `ideasResponse` says one sentence instead, and says it the
same way whatever NODE_ENV happens to be, so the answer does not depend on how the
container was started. The detail goes to the log.

### Notion said no, or could not be reached: 502, `notionFailure`

Creator shipments live in a Notion database, read and written through `lib/shipments.ts`.
When Notion refuses or cannot be reached while serving the shipments page, one sentence
with Notion's status goes to the caller and to the log; Notion's own body never does,
because it can echo the request back. 502 rather than 500: the fault is upstream, and an
unhandled throw would be answered with Bun's own page.

### Shipments without the Notion key: 503 on write

Without the integration key the shipments page still opens and points at Notion, and a
write is refused with 503, one sentence and the Notion link, and a log line. Nothing on
that route throws for a missing key.

## Not ours: the request body cap, `MAX_REQUEST_BODY_BYTES`

A body over 1 MB is refused by Bun itself, before the handler runs: an empty 413 with no
sentence, and nothing is logged. This process cannot change that answer, so it is outside
the rule above.

The cap exists because Bun's default ceiling is 128 MB, which on a public endpoint is a
free way to make us hold rubbish in memory. 1 MB is far above any body the portal's own
pages send: an idea is at most about 4,300 characters (title 200, body 4,000, author 100),
a shipment about 4,500 (notes 2,000, tracking link 2,000, email 254, creator 120, logged
by 60, plus short fixed choices), and a gift claim is an email address and a few short choices.
Even escaped as JSON in UTF-8, each is a few tens of KB at most.
