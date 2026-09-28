// The emailer's door into the gift offer signups: two server-to-server routes behind
// x-lp-admin-secret. docs/GIFT-EMAIL-ROUTES.md, and why its own secret: docs/SERVER-SECRETS.md

import { secretMatches } from "./secret.ts";
import {
  SENT_FILE,
  appendSent,
  readSentEvents,
  readSignups,
  type SignupRow,
} from "./lp-aboard-store.ts";

const ADMIN_SECRET = (process.env.LP_ADMIN_SECRET || "").trim();

if (!ADMIN_SECRET) {
  console.warn(
    "[lp/aboard admin] LP_ADMIN_SECRET is not set: every request to /lp/aboard/signups " +
      "and /lp/aboard/signups/mark-sent will be refused with 403, so the emailer can read " +
      "nothing and mark nothing. Set it here and in the emailer before the first gift email."
  );
}

/** True when this request proved it is the emailer. */
function callerIsTrusted(req: Request): boolean {
  return secretMatches((req.headers.get("x-lp-admin-secret") || "").trim(), ADMIN_SECRET);
}

// Rows carry email addresses, so no cache anywhere is allowed to keep a copy of any
// answer these two routes give.
const JSON_HEADERS = { "Cache-Control": "no-store" };

// Same wording as the claim endpoint uses, and just as empty. A refused caller
// learns nothing about the route, the store or the secret.
function forbidden(): Response {
  return Response.json({ error: "Not available here" }, { status: 403, headers: JSON_HEADERS });
}

function methodNotAllowed(allowed: string): Response {
  return Response.json(
    { error: `Use ${allowed}` },
    { status: 405, headers: { ...JSON_HEADERS, Allow: allowed } }
  );
}

/** The event id on a stored row, or "" for a row that has none. */
function eventId(row: SignupRow): string {
  return typeof row.event === "string" ? row.event : "";
}

// GET /lp/aboard/signups: unsent rows exactly as stored, oldest first; ?all=1 for every
// row with its sent flag. docs/GIFT-EMAIL-ROUTES.md
export function handleSignups(req: Request): Response {
  if (!callerIsTrusted(req)) {
    console.warn("[lp/aboard admin] signups read rejected reason=unauthenticated");
    return forbidden();
  }

  if (req.method !== "GET") return methodNotAllowed("GET");

  let store: ReturnType<typeof readSignups>;
  let ledger: ReturnType<typeof readSentEvents>;
  try {
    store = readSignups();
    ledger = readSentEvents();
  } catch (err) {
    // The files are there but we cannot read them. Saying "no rows" here would tell
    // the emailer there is nobody waiting, which is the one wrong answer.
    console.error("[lp/aboard admin] FAILED to read the signup store:", err);
    return Response.json({ error: "Could not read the signup store" }, { status: 503, headers: JSON_HEADERS });
  }

  const all = new URL(req.url).searchParams.get("all");
  const wantAll = all === "1" || all === "true";

  // A row with no event id can never be marked sent, so it would come back forever.
  // It should not exist: the claim endpoint puts an event id on every row it writes.
  const withoutEvent = store.rows.filter((row) => !eventId(row)).length;
  if (withoutEvent) {
    console.error(
      `[lp/aboard admin] ${withoutEvent} stored row(s) have no event id, so they can never be marked sent`
    );
  }

  const isSent = (row: SignupRow) => {
    const id = eventId(row);
    return id !== "" && ledger.events.has(id);
  };

  // Worked out once, then either handed back on its own or used for the count next
  // to every row.
  const unsentRows = store.rows.filter((row) => !isSent(row));
  const rows = wantAll ? store.rows.map((row) => ({ ...row, sent: isSent(row) })) : unsentRows;
  const unsent = unsentRows.length;

  // Counts only. Not one email address, code or country goes anywhere near the log.
  console.log(
    `[lp/aboard admin] signups read all=${wantAll} total=${store.rows.length} unsent=${unsent} returned=${rows.length}`
  );

  const problems = {
    ...(store.malformed ? { malformedRows: store.malformed } : {}),
    ...(ledger.malformed ? { malformedLedgerLines: ledger.malformed } : {}),
    ...(withoutEvent ? { rowsWithoutEventId: withoutEvent } : {}),
  };

  return Response.json(
    {
      rows,
      total: store.rows.length,
      unsent,
      ...(Object.keys(problems).length ? { problems } : {}),
    },
    { headers: JSON_HEADERS }
  );
}

// POST /lp/aboard/signups/mark-sent {"events": [...]}: marked, alreadySent and unknown
// lists, a 503 with "failed" per id. docs/GIFT-EMAIL-ROUTES.md
export async function handleMarkSent(req: Request): Promise<Response> {
  if (!callerIsTrusted(req)) {
    console.warn("[lp/aboard admin] mark-sent rejected reason=unauthenticated");
    return forbidden();
  }

  if (req.method !== "POST") return methodNotAllowed("POST");

  const body = await req.json().catch(() => {
    // What was in the body is not logged, not even through the parser's own error
    // message: a caller can put anything in there, an email address included.
    console.warn("[lp/aboard admin] mark-sent body was not valid JSON");
    return null;
  });

  const events = body && typeof body === "object" ? (body as { events?: unknown }).events : undefined;
  if (!Array.isArray(events) || !events.every((e) => typeof e === "string" && e.trim() !== "")) {
    console.warn("[lp/aboard admin] mark-sent rejected reason=bad-body");
    return Response.json(
      { error: 'Body must be {"events": ["<event id>", ...]}' },
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // The same id twice in one body is one signup, so it gets one ledger line.
  const requested = [...new Set(events.map((e) => e.trim()))];

  let known: Set<string>;
  let ledger: Set<string>;
  try {
    known = new Set(readSignups().rows.map(eventId).filter(Boolean));
    ledger = readSentEvents().events;
  } catch (err) {
    // Without the store we cannot tell a known id from an unknown one, and guessing
    // would either drop a real signup into "unknown" or mark one that does not exist.
    console.error("[lp/aboard admin] FAILED to read the signup store while marking sent:", err);
    return Response.json({ error: "Could not read the signup store" }, { status: 503, headers: JSON_HEADERS });
  }

  const marked: string[] = [];
  const alreadySent: string[] = [];
  const unknown: string[] = [];
  const failed: string[] = [];

  for (const event of requested) {
    // Ledger first: an emailed id stays "already sent" even if its row has gone.
    // docs/GIFT-EMAIL-ROUTES.md
    if (ledger.has(event)) {
      alreadySent.push(event);
      continue;
    }
    if (!known.has(event)) {
      unknown.push(event);
      continue;
    }

    try {
      appendSent(event);
      marked.push(event);
    } catch (err) {
      // Every id is its own line and its own append, so one failure does not put the
      // others in doubt. The caller is told exactly which ones did not land.
      console.error(`[lp/aboard admin] FAILED to append ${SENT_FILE} event=${event}:`, err);
      failed.push(event);
    }
  }

  // Event ids are random and carry nothing about the person, which is why they are
  // the one thing the claim endpoint already logs. Emails and codes are not here.
  console.log(
    `[lp/aboard admin] mark-sent marked=${marked.length} alreadySent=${alreadySent.length} ` +
      `unknown=${unknown.length} failed=${failed.length}`
  );

  if (failed.length) {
    return Response.json(
      {
        marked,
        alreadySent,
        unknown,
        failed,
        error: "Some events could not be written to the sent ledger",
      },
      { status: 503, headers: JSON_HEADERS }
    );
  }

  return Response.json({ marked, alreadySent, unknown }, { headers: JSON_HEADERS });
}
