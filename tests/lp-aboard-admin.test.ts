// Tests for the emailer's two routes: the authenticated signup reader and the sent
// ledger. Straight off the acceptance criteria in issue #4.
//
// The handlers are called directly with Request objects. No server is started,
// except for one child process that checks what an unset LP_ADMIN_SECRET does,
// which cannot be checked in here: the module reads the secret once at import.
//
// About the store: bun test shares one module cache across test files, so the first
// test file to import lib/state-dir.ts fixes STATE_DIR for the whole run. Which file
// that is depends on the order bun happens to load them in. So this file never
// assumes the store is empty, never assumes it owns it, and asks the store module
// where its files are instead of rebuilding the paths from a scratch dir here. Every
// assertion below is about rows this file wrote, found by their own event ids.

import { test, expect, beforeAll } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Only if no other test file got there first. Overwriting it would send the claim
// tests' writes to a directory they are not reading.
const TEST_STATE = mkdtempSync(join(tmpdir(), "lp-aboard-admin-test-"));
if (!process.env.STATE_DIR) process.env.STATE_DIR = TEST_STATE;

// The emailer's shared secret, set before the module reads it at import time.
const ADMIN_SECRET = "test-admin-secret-9d41b7";
process.env.LP_ADMIN_SECRET = ADMIN_SECRET;

const REPO_DIR = join(import.meta.dir, "..");

let handleSignups: (req: Request) => Response;
let handleMarkSent: (req: Request) => Promise<Response>;
let handleAsset: (path: string) => Response | null;
let appendSignup: (row: Record<string, unknown>) => void;
let SENT_FILE: string;

beforeAll(async () => {
  // Set again here, not only at the top of the file: top level code of every test
  // file runs before any of them import anything, so this is the last moment before
  // the module reads it.
  process.env.LP_ADMIN_SECRET = ADMIN_SECRET;

  const admin = await import("../lib/lp-aboard-admin.ts");
  handleSignups = admin.handleSignups;
  handleMarkSent = admin.handleMarkSent;

  const store = await import("../lib/lp-aboard-store.ts");
  appendSignup = store.appendSignup;
  SENT_FILE = store.SENT_FILE;

  handleAsset = (await import("../lib/lp-aboard.ts")).handleAsset;
});

/** A GET on the reader, carrying whatever headers the caller wants. */
function get(headers: Record<string, string>, query = ""): Response {
  return handleSignups(
    new Request(`https://marketing.nordicpirate.com/lp/aboard/signups${query}`, { headers })
  );
}

/** An authenticated GET. */
function read(query = ""): Response {
  return get({ "x-lp-admin-secret": ADMIN_SECRET }, query);
}

function markWithHeaders(events: unknown, headers: Record<string, string>): Promise<Response> {
  return handleMarkSent(
    new Request("https://marketing.nordicpirate.com/lp/aboard/signups/mark-sent", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ events }),
    })
  );
}

/** An authenticated mark-sent. */
function mark(events: unknown): Promise<Response> {
  return markWithHeaders(events, { "x-lp-admin-secret": ADMIN_SECRET });
}

// Event ids that cannot be confused with a real one (12 random hex from the claim
// endpoint) or with another test's. One counter, so ids stay unique within the run.
let fixtureCount = 0;
function fixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  fixtureCount++;
  const event = `feed0000${String(fixtureCount).padStart(4, "0")}`;
  const row = {
    event,
    ts: new Date().toISOString(),
    email: `mailer-fixture-${fixtureCount}@example.test`,
    offer: "base-kraken",
    edition: "de",
    country: "DE",
    state: "code",
    code: "KRAKEN-A7F2",
    shownCode: "KRAKEN-A7F2",
    cartUrl: "https://nordicpirates.com/cart/51542813540699:1?discount=KRAKEN-A7F2",
    ...extra,
  };
  appendSignup(row);
  return row;
}

function rowsOf(res: Response): Promise<Record<string, any>[]> {
  return res.json().then((body) => body.rows);
}

/** Just the rows this test wrote, in the order the reader returned them. */
function mine(rows: Record<string, any>[], events: string[]): Record<string, any>[] {
  const wanted = new Set(events);
  return rows.filter((r) => wanted.has(r.event));
}

function sentLedgerLines(): Record<string, any>[] {
  if (!existsSync(SENT_FILE)) return [];
  return readFileSync(SENT_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("both routes refuse anything that is not the emailer, and leak nothing", async () => {
  // Same table as the claim endpoint's: no secret, a wrong one, a near miss on
  // length, an empty one. Plus the Worker's header name, which must not open this
  // door: that secret only proves a request came through the edge, it is not
  // permission to read everybody's email address.
  const attempts: Record<string, Record<string, string>> = {
    "no headers at all": {},
    "wrong secret": { "x-lp-admin-secret": "not-the-secret" },
    "secret one char short": { "x-lp-admin-secret": ADMIN_SECRET.slice(0, -1) },
    "secret with one char too many": { "x-lp-admin-secret": ADMIN_SECRET + "x" },
    "right length, wrong value": { "x-lp-admin-secret": "x".repeat(ADMIN_SECRET.length) },
    "empty secret": { "x-lp-admin-secret": "" },
    "right value, wrong header": { "x-lp-proxy-secret": ADMIN_SECRET },
    "a cookie instead of the secret": { cookie: "auth=" + "a".repeat(64) },
  };

  const known = fixture();
  const ledgerBefore = sentLedgerLines().length;

  for (const [name, headers] of Object.entries(attempts)) {
    const readRes = get(headers);
    expect(readRes.status).toBe(403);

    // Not one row, not one count, nothing about the store.
    const readBody = await readRes.json();
    expect(readBody.rows).toBeUndefined();
    expect(readBody.total).toBeUndefined();
    expect(readBody.unsent).toBeUndefined();
    expect(JSON.stringify(readBody)).not.toContain("@");

    const markRes = await markWithHeaders([known.event], headers);
    expect(markRes.status).toBe(403);

    const markBody = await markRes.json();
    expect(markBody.marked).toBeUndefined();
    expect(markBody.alreadySent).toBeUndefined();
    expect(markBody.unknown).toBeUndefined();

    // And the refused call really did nothing: `name` is only here to name the case
    // in a failure message.
    expect(`${name}: ${sentLedgerLines().length}`).toBe(`${name}: ${ledgerBefore}`);
  }

  // The row it tried to mark is still waiting to be emailed.
  expect(mine(await rowsOf(read()), [known.event]).length).toBe(1);
});

test("an unset LP_ADMIN_SECRET refuses everybody, it does not let everybody in", () => {
  // The module reads the secret once at import, so this cannot be checked in this
  // process: something has already imported it with a secret set. A child process
  // with no LP_ADMIN_SECRET in its environment is the real thing.
  const probeDir = mkdtempSync(join(tmpdir(), "lp-admin-unset-"));
  const script = join(probeDir, "probe.ts");
  writeFileSync(
    script,
    `import { handleSignups, handleMarkSent } from ${JSON.stringify(join(REPO_DIR, "lib", "lp-aboard-admin.ts"))};
const url = "https://marketing.nordicpirate.com/lp/aboard/signups";
const headers = { "x-lp-admin-secret": "any-guess-at-all", "Content-Type": "application/json" };
const getRes = handleSignups(new Request(url, { headers }));
const postRes = await handleMarkSent(
  new Request(url + "/mark-sent", { method: "POST", headers, body: JSON.stringify({ events: ["x"] }) })
);
// An empty presented secret must not match an empty configured one either.
const emptyRes = handleSignups(new Request(url, { headers: { "x-lp-admin-secret": "" } }));
console.log("__RESULT__" + JSON.stringify({
  get: getRes.status,
  post: postRes.status,
  empty: emptyRes.status,
  getBody: await getRes.text(),
}));
`
  );

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.LP_ADMIN_SECRET;
  env.STATE_DIR = probeDir;

  const proc = Bun.spawnSync({ cmd: ["bun", "run", script], env, stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const marker = stdout.split("__RESULT__")[1];
  if (!marker) {
    // Never swallow this: without the child's output a failure here says nothing.
    throw new Error(`the unset-secret probe printed no result.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const result = JSON.parse(marker.trim());
  expect(result.get).toBe(403);
  expect(result.post).toBe(403);
  expect(result.empty).toBe(403);
  expect(result.getBody).not.toContain("rows");

  // And it says so at boot rather than failing silently.
  expect(stdout + stderr).toContain("LP_ADMIN_SECRET is not set");
});

test("the reader returns unsent rows exactly as stored, oldest first", async () => {
  const a = fixture();
  const b = fixture({ state: "blocked", code: "KRAKEN-A7F2", shownCode: "FULLHOLD-B642" });
  const c = fixture({ country: null, edition: "en" });

  const res = read();
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("application/json");

  const rows = mine(await rowsOf(res), [a.event, b.event, c.event] as string[]);

  // File order, not insertion order of some map.
  expect(rows.map((r) => r.event)).toEqual([a.event, b.event, c.event]);

  // Verbatim: every field the emailer needs, including the two codes, and nothing
  // added to the row itself.
  expect(rows[0]).toEqual(a);
  expect(rows[1]).toEqual(b);
  expect(rows[2]).toEqual(c);
  expect("sent" in rows[0]).toBe(false);
});

test("marking a row sent takes it out of the reader, and the reader is the only thing that changes", async () => {
  const a = fixture();
  const b = fixture();

  expect(mine(await rowsOf(read()), [a.event, b.event] as string[]).length).toBe(2);

  const res = await mark([a.event]);
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.marked).toEqual([a.event]);
  expect(body.alreadySent).toEqual([]);
  expect(body.unknown).toEqual([]);

  // Gone from the default view, still in the file.
  const left = mine(await rowsOf(read()), [a.event, b.event] as string[]);
  expect(left.map((r) => r.event)).toEqual([b.event]);

  const all = mine(await rowsOf(read("?all=1")), [a.event, b.event] as string[]);
  expect(all.map((r) => r.event)).toEqual([a.event, b.event]);
  expect(all[0].sent).toBe(true);
  expect(all[1].sent).toBe(false);
  // Still the stored row, with the flag added and nothing taken away.
  expect(all[0]).toEqual({ ...a, sent: true });

  // One ledger line, carrying the event id and when it was sent.
  const line = sentLedgerLines().find((l) => l.event === a.event);
  expect(line).toBeDefined();
  expect(typeof line!.sentAt).toBe("string");
  expect(new Date(line!.sentAt).toString()).not.toBe("Invalid Date");
});

test("marking the same event twice is a no-op the second time", async () => {
  const a = fixture();

  const first = await mark([a.event]);
  expect((await first.json()).marked).toEqual([a.event]);

  const linesAfterFirst = sentLedgerLines().length;

  const second = await mark([a.event]);
  expect(second.status).toBe(200);

  const body = await second.json();
  expect(body.marked).toEqual([]);
  expect(body.alreadySent).toEqual([a.event]);

  // Nothing appended the second time, so the ledger cannot grow by re-running the
  // emailer over a batch it has already done.
  expect(sentLedgerLines().length).toBe(linesAfterFirst);
  expect(sentLedgerLines().filter((l) => l.event === a.event).length).toBe(1);
});

test("the same id twice in one body gets one ledger line", async () => {
  const a = fixture();

  const res = await mark([a.event, a.event, a.event]);
  expect(res.status).toBe(200);
  expect((await res.json()).marked).toEqual([a.event]);
  expect(sentLedgerLines().filter((l) => l.event === a.event).length).toBe(1);
});

test("unknown ids are reported, not refused, and the known ones still land", async () => {
  const a = fixture();
  const b = fixture();
  await mark([b.event]);

  const res = await mark([a.event, "no-such-event-id", b.event, "another-ghost"]);
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.marked).toEqual([a.event]);
  expect(body.alreadySent).toEqual([b.event]);
  expect(body.unknown).toEqual(["no-such-event-id", "another-ghost"]);

  // An unknown id writes nothing at all.
  expect(sentLedgerLines().some((l) => l.event === "no-such-event-id")).toBe(false);
});

test("a mark-sent write failure returns 503 and says exactly which ids landed", async () => {
  // Make the ledger unwritable for real rather than mocking the failure away.
  const a = fixture();
  const b = fixture();

  // The ledger has to exist before it can be made read only.
  await mark([fixture().event]);
  expect(existsSync(SENT_FILE)).toBe(true);

  const before = sentLedgerLines();
  chmodSync(SENT_FILE, 0o444);

  let res: Response;
  try {
    res = await mark([a.event, b.event, "a-ghost"]);
  } finally {
    chmodSync(SENT_FILE, 0o644);
  }

  expect(res!.status).toBe(503);

  const body = await res!.json();
  // Nothing landed, and the answer says so instead of claiming a half done batch.
  expect(body.marked).toEqual([]);
  expect(body.failed).toEqual([a.event, b.event]);
  expect(body.unknown).toEqual(["a-ghost"]);
  expect(typeof body.error).toBe("string");

  // The file is intact: no partial line, nothing lost.
  expect(sentLedgerLines()).toEqual(before);

  // Both rows are still waiting to be emailed, which is the whole point: a failed
  // mark must never look like a sent email.
  expect(mine(await rowsOf(read()), [a.event, b.event] as string[]).length).toBe(2);

  // And it recovers once the disk does.
  const after = await mark([a.event, b.event]);
  expect(after.status).toBe(200);
  expect((await after.json()).marked).toEqual([a.event, b.event]);
});

test("a body that is not a list of event ids is refused with 400", async () => {
  const before = sentLedgerLines().length;

  for (const events of [undefined, null, "abc", 42, {}, [1, 2], ["ok", 7], [""], ["  "], [null]]) {
    const res = await mark(events);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.marked).toBeUndefined();
  }

  // Not even valid JSON.
  const junk = await handleMarkSent(
    new Request("https://marketing.nordicpirate.com/lp/aboard/signups/mark-sent", {
      method: "POST",
      headers: { "x-lp-admin-secret": ADMIN_SECRET, "Content-Type": "application/json" },
      body: "{not json",
    })
  );
  expect(junk.status).toBe(400);

  // An empty list is a valid question with an empty answer, not an error.
  const empty = await mark([]);
  expect(empty.status).toBe(200);
  const emptyBody = await empty.json();
  expect(emptyBody.marked).toEqual([]);
  expect(emptyBody.alreadySent).toEqual([]);
  expect(emptyBody.unknown).toEqual([]);

  expect(sentLedgerLines().length).toBe(before);
});

test("each route answers only its own method", async () => {
  const post = await handleSignups(
    new Request("https://marketing.nordicpirate.com/lp/aboard/signups", {
      method: "POST",
      headers: { "x-lp-admin-secret": ADMIN_SECRET },
    })
  );
  expect(post.status).toBe(405);
  expect(post.headers.get("Allow")).toBe("GET");

  const getMark = await handleMarkSent(
    new Request("https://marketing.nordicpirate.com/lp/aboard/signups/mark-sent", {
      headers: { "x-lp-admin-secret": ADMIN_SECRET },
    })
  );
  expect(getMark.status).toBe(405);
  expect(getMark.headers.get("Allow")).toBe("POST");
});

test("these routes are not a browser surface", async () => {
  // Not in the public asset map, so nothing under them can be served as a file.
  for (const path of [
    "/lp/aboard/signups",
    "/lp/aboard/signups/mark-sent",
    "/lp/aboard/lp-aboard-sent.jsonl",
  ]) {
    expect(handleAsset(path)).toBeNull();
  }

  const res = read();
  // No CORS: a page in someone's browser must never be able to call this, with or
  // without the secret.
  for (const header of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
  ]) {
    expect(res.headers.get(header)).toBeNull();
  }
  // Rows carry email addresses, so no cache may keep a copy.
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Content-Type")).not.toContain("text/html");

  // And nothing the browser receives mentions them.
  const html = await handleAsset("/lp/aboard")!.text();
  const js = await handleAsset("/lp/aboard/page.js")!.text();
  const css = await handleAsset("/lp/aboard/style.css")!.text();
  const offerJs = await handleAsset("/lp/aboard/offer.js")!.text();
  for (const delivered of [html, js, css, offerJs]) {
    expect(delivered).not.toContain("signups");
    expect(delivered).not.toContain("mark-sent");
    expect(delivered).not.toContain("x-lp-admin-secret");
    expect(delivered).not.toContain(ADMIN_SECRET);
  }
});

test("logs carry no emails, no codes and no secret, only counts and event ids", async () => {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  const row = fixture({ email: "very.private.person@secret-domain.example" });

  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    read();
    read("?all=1");
    await mark([row.event, "ghost-id"]);
    await mark([row.event]);
    get({ "x-lp-admin-secret": "a-guess-at-the-secret" });
    await markWithHeaders([row.event], {});
    await mark("not a list");
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  const logged = lines.join("\n");
  expect(lines.length).toBeGreaterThan(0);

  for (const secret of [
    "very.private.person@secret-domain.example",
    "secret-domain.example",
    "mailer-fixture", // every fixture email starts with this
    "KRAKEN-A7F2", // discount codes
    "FULLHOLD-B642",
    "a-guess-at-the-secret", // never echo a presented secret
    ADMIN_SECRET,
  ]) {
    expect(logged).not.toContain(secret);
  }

  // What it SHOULD say: what the route did, in counts.
  expect(logged).toContain("signups read");
  expect(logged).toContain("mark-sent marked=");
  expect(logged).toContain("reason=unauthenticated");
  expect(logged).toContain("reason=bad-body");
});

test("a broken line in the store is reported, not silently skipped", async () => {
  // Nothing writes a half line today, but a full disk could. The emailer must be
  // told the file has a line nobody can read rather than being handed a short list
  // that looks complete.
  const good = fixture();

  const { SIGNUPS_FILE } = await import("../lib/lp-aboard-store.ts");
  const intact = readFileSync(SIGNUPS_FILE, "utf8");

  let body: any;
  try {
    appendFileSync(SIGNUPS_FILE, '{"event":"broken","email":"half-a-row@example.test"\n');
    const res = read();
    expect(res.status).toBe(200);
    body = await res.json();
  } finally {
    // Put the store back exactly as it was. The claim tests share this file and
    // parse every line of it, so a half line left behind would fail them instead.
    writeFileSync(SIGNUPS_FILE, intact);
  }

  expect(body.problems.malformedRows).toBeGreaterThan(0);

  // The readable rows still come back: one bad line does not stop the emailer.
  expect(mine(body.rows, [good.event] as string[]).length).toBe(1);
});
