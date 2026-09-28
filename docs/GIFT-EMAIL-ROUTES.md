# The emailer's door into the gift offer signups

`lib/lp-aboard-admin.ts` is how the job that sends the gift code email reads the signups
and records which ones it has sent. What goes in each email is `docs/GIFT-EMAIL.md`; the
secret that guards these routes is `docs/SERVER-SECRETS.md`.

## Why the emailer needs a door at all

The gift page stores every submission in `STATE_DIR/lp-aboard-signups.jsonl` inside the
container. The job that actually sends the gift code email runs outside the container, so
it needs a way to read the rows and to say which ones it has sent. The container log
cannot be that channel: it is PII free by design and holds no email addresses at all.

## Two routes, both server to server only

```
GET  /lp/aboard/signups            rows not emailed yet, oldest first
POST /lp/aboard/signups/mark-sent  add ids to the sent ledger
```

Neither is a browser surface. There is no page, no CORS header and no cookie or session
fallback: the only way in is the shared secret in `x-lp-admin-secret`, checked the same
constant time way as the Worker's secret on the claim endpoint. `LP_ADMIN_SECRET` unset
means nothing matches, so an unconfigured deploy answers 403 to everybody rather than
handing the signup list to anybody who asks.

## `GET /lp/aboard/signups`

Answers `{"rows": [...]}` with the stored rows the emailer has not marked sent, in the
order they were written. Each row is the stored object exactly as it is on disk, so a code
that was issued before a rotation still says which code the person was actually shown.

`?all=1` returns every row instead, each with `sent: true` or `sent: false`, which is what
you want when checking what the emailer has been doing rather than sending mail.

Counts and any problems with the files come back alongside the rows, so a broken line in
the store is visible to whoever is looking, not just to the container log.

## `POST /lp/aboard/signups/mark-sent`

The body is `{"events": ["<id>", ...]}`. It adds a line to the sent ledger for each id,
and answers with three lists saying what happened to every id it was given:

| List | Meaning |
|---|---|
| `marked` | written to the ledger just now |
| `alreadySent` | the ledger already had it, so nothing was written |
| `unknown` | no stored signup has that id, so nothing was written |

Re-sending the same body is a no op: everything lands in `alreadySent` the second time.
An unknown id is an answer, not an error, because the emailer asking about an id we have
never seen is worth reporting but is not a reason to refuse the whole batch.

The ledger is checked first on purpose. An id that has been emailed stays "already sent"
even if its signup row has since been taken out of the file: the useful answer to "have we
mailed this one" is yes, not "never heard of it".

Each id is appended on its own, so a write failure is reported per id. If any append
fails the answer is 503 with a `failed` list, and `marked` still says exactly which ids
did land. Nothing is ever half written: an id is either a line in the ledger or in one of
the other lists.
