# The append-only JSONL stores

Three files on the persistent volume (`STATE_DIR`, the `./state` volume in `gate.json`)
are written one line at a time and never rewritten:

| File | Written by | Read by |
|---|---|---|
| `lp-aboard-signups.jsonl` | the gift claim endpoint, one line per submission | the emailer's routes |
| `lp-aboard-sent.jsonl` | the emailer's mark-sent route, one line per emailed signup | the emailer's routes |
| `qr-scans.jsonl` | the QR edge, through `POST /qr/hit`, one line per scan | `GET /api/qr` |

None of them is reachable over HTTP: no route serves files from `STATE_DIR`.

## Why append only

A line is never edited after it lands, so a crash halfway through a write can cost the
last line but never damage an earlier one, and a writer never has to read back what it
wrote. Marking a signup as sent adds a line to a second file instead of touching the
first.

Each line is one `appendFileSync` call, so it is written by a single append syscall and
two writers cannot interleave halfway through a line. Batches are never written: a
half-written batch would leave the caller unable to say what landed.

## Reading: `readJsonlObjects` in `lib/jsonl.ts`

The one reader all three files go through.

- A file that is not there yet is not a problem: nobody has signed up, been emailed or
  scanned yet. It reads as empty.
- A file that IS there but cannot be read throws. Answering "no rows" to that would tell
  the emailer there is no work, or tell the QR page nobody scanned, when the opposite may
  be true.
- A line that will not parse, or parses to something that is not an object, is counted
  and reported to the caller rather than quietly dropped. Callers pass the count on as
  `problems` in their answer.

## Nothing from a line reaches the log

The signups file holds email addresses. A bad line is reported by file name and line
number only, never its contents and never the parser's error message, because both can
quote the input. A file name and a line number are enough to go and look at the real
file, and the container log is a much looser place than the volume.

## Throwing writers

`appendSignup` throws when the line did not land, and the claim endpoint must then not
answer with a code: the emailer reads this file and nothing else. `appendSent` throws
per event, so the mark-sent route can report exactly which ids made it into the ledger.
The QR hit route answers 503 when its line did not land, so the edge's log shows it.
