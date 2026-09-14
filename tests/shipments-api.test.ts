// The /shipments page and the /api/shipments verbs, against a real server.
//
// Like tests/ideas-api.test.ts this starts server.ts as a child process and logs in the
// way a person does. It runs the server twice: first without a Notion key, which is how
// it is deployed until Lucas creates the integration, and then with a key pointed at a
// fake Notion this file runs, so the real route code is what talks to it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SERVER_STATE = mkdtempSync(join(tmpdir(), "shipments-api-test-"));
const PASSWORD = "test-portal-password-9c17";
const TOKEN = "secret_test_integration_key";
const DB = "db-test-0000-1111";
const NOTION_URL = "https://app.notion.com/p/e13c793a116742dca45f3264a145b808";

if (!process.env.STATE_DIR) process.env.STATE_DIR = SERVER_STATE;

let proc: any = null;
let base = "";
let auth = "";

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** A Notion that answers the two calls the server makes, and remembers what it was asked. */
const notion = {
  mode: "ok" as "ok" | "404" | "500",
  queries: [] as any[],
  creates: [] as any[],
  headers: [] as Record<string, string>[],
  server: null as any,
  page(n: number, creator: string, sent: string) {
    return {
      object: "page",
      id: `page-${n}`,
      created_time: "2026-09-14T10:00:00.000Z",
      url: `https://www.notion.so/page-${n}`,
      properties: {
        Creator: { type: "title", title: [{ plain_text: creator }] },
        Game: { type: "select", select: { name: "Cities of Greed" } },
        Quantity: { type: "number", number: 1 },
        Sent: { type: "date", date: { start: sent } },
        Status: { type: "select", select: { name: "Sent" } },
        "Logged by": { type: "rich_text", rich_text: [{ plain_text: "Bengt" }] },
      },
    };
  },
};

function startNotion() {
  notion.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      notion.headers.push({
        authorization: req.headers.get("authorization") || "",
        version: req.headers.get("notion-version") || "",
      });
      if (notion.mode === "404") return Response.json({ object: "error", status: 404, code: "object_not_found", message: "Could not find database" }, { status: 404 });
      if (notion.mode === "500") return Response.json({ object: "error", status: 500, message: "Internal" }, { status: 500 });
      if (url.pathname === `/v1/databases/${DB}/query`) {
        notion.queries.push(body);
        if (!body?.start_cursor) return Response.json({ results: [notion.page(1, "Quackalope", "2025-11-24")], has_more: true, next_cursor: "c-1" });
        return Response.json({ results: [notion.page(2, "Meeple University", "2025-11-20")], has_more: false, next_cursor: null });
      }
      if (url.pathname === "/v1/pages") {
        notion.creates.push(body);
        return Response.json({ object: "page", id: "page-new", url: "https://www.notion.so/page-new", created_time: "2026-09-14T12:00:00.000Z", properties: body.properties });
      }
      return Response.json({ object: "error", status: 404, message: `no route for ${url.pathname}` }, { status: 404 });
    },
  });
}

async function start(env: Record<string, string>): Promise<void> {
  const port = freePort();
  base = `http://localhost:${port}`;
  proc = Bun.spawn({
    cmd: ["bun", "run", join(REPO, "server.ts")],
    env: { ...process.env, PORT: String(port), STATE_DIR: SERVER_STATE, AUTH_PASSWORD: PASSWORD, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let waited = 0; waited < 15000; waited += 50) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`the server never answered /health on ${base}`);
}

async function stop(): Promise<void> {
  if (!proc) return;
  proc.kill();
  await proc.exited;
  proc = null;
}

async function login(): Promise<string> {
  const form = new FormData();
  form.set("password", PASSWORD);
  const res = await fetch(`${base}/login`, { method: "POST", body: form, redirect: "manual" });
  expect(res.status).toBe(302);
  const cookie = (res.headers.get("set-cookie") || "").match(/auth=[a-f0-9]{64}/);
  if (!cookie) throw new Error("POST /login did not set an auth cookie");
  return cookie[0];
}

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers, redirect: "manual" });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });
const rawPost = (path: string, body: unknown, headers: Record<string, string>) =>
  fetch(base + path, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
const asStaff = () => ({ cookie: auth });

const GOOD = { creator: "Board Game Barrage", game: "TAP 10: Inventions", quantity: 2, sent: "2026-09-14", shipped_from: "Stockholm office", platform: "YouTube", logged_by: "Lucas" };

describe("deployed without the Notion key, which is how it starts", () => {
  beforeAll(async () => {
    await start({ NOTION_PORTAL_TOKEN: "" });
    auth = await login();
  });
  afterAll(stop);

  test("the page and the API are behind the staff password", async () => {
    const page = await get("/shipments");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    const api = await get("/api/shipments");
    expect(api.status).toBe(401);
  });

  test("the page is served", async () => {
    const res = await get("/shipments", asStaff());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Creator shipments");
    expect(html).toContain('href="/shipments" class="active"');
  });

  test("GET says it is not configured and points at Notion, and never throws", async () => {
    const res = await get("/api/shipments", asStaff());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, notion_url: NOTION_URL, shipments: [] });
  });

  test("POST is refused with 503 and the Notion link", async () => {
    const res = await post("/api/shipments", GOOD, asStaff());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("the Notion key is missing");
    expect(body.notion_url).toBe(NOTION_URL);
  });

  test("the hub's quick links reach the page", async () => {
    const hub = await (await get("/", asStaff())).text();
    expect(hub).toContain('href="/shipments"');
  });
});

describe("with the key, against a Notion this file runs", () => {
  beforeAll(async () => {
    startNotion();
    await start({
      NOTION_PORTAL_TOKEN: TOKEN,
      NOTION_SHIPMENTS_DB: DB,
      NOTION_API_BASE: `http://localhost:${notion.server.port}/v1`,
    });
    auth = await login();
  });
  afterAll(async () => {
    await stop();
    notion.server?.stop(true);
  });

  test("a refusal from Notion is a 502 with the status, the hint and the Notion link, and is not cached", async () => {
    notion.mode = "404";
    const res = await get("/api/shipments", asStaff());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Notion answered 404");
    expect(body.error).toContain("not shared with the integration");
    expect(body.notion_status).toBe(404);
    expect(body.notion_url).toBe(NOTION_URL);
    expect(body.error).not.toContain("Could not find database");
    notion.mode = "ok";
  });

  test("GET reads every page of the database with the key, sorted by Sent, and reuses the answer for a while", async () => {
    const before = notion.queries.length;
    const res = await get("/api/shipments", asStaff());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.notion_url).toBe(NOTION_URL);
    expect(body.shipments.map((s: any) => s.creator)).toEqual(["Quackalope", "Meeple University"]);
    expect(body.shipments[0]).toMatchObject({ game: "Cities of Greed", quantity: 1, sent: "2025-11-24", status: "Sent", logged_by: "Bengt", url: "https://www.notion.so/page-1" });

    expect(notion.queries.length).toBe(before + 2);
    expect(notion.queries[before]).toEqual({ sorts: [{ property: "Sent", direction: "descending" }], page_size: 100 });
    expect(notion.queries[before + 1].start_cursor).toBe("c-1");
    const last = notion.headers[notion.headers.length - 1];
    expect(last.authorization).toBe(`Bearer ${TOKEN}`);
    expect(last.version).toBe("2022-06-28");

    // A second read inside the cache window does not reach Notion.
    const again = await get("/api/shipments", asStaff());
    expect(again.status).toBe(200);
    expect(notion.queries.length).toBe(before + 2);
  });

  test("POST creates the row in Notion with Status Sent, answers 201 with it, and the next GET reads afresh", async () => {
    const queriesBefore = notion.queries.length;
    const res = await post("/api/shipments", { ...GOOD, notes: "Prototype copy", tracking: "https://t.example/1" }, asStaff());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.shipment).toMatchObject({ creator: "Board Game Barrage", game: "TAP 10: Inventions", quantity: 2, sent: "2026-09-14", status: "Sent", logged_by: "Lucas", notes: "Prototype copy", tracking: "https://t.example/1" });

    expect(notion.creates).toHaveLength(1);
    expect(notion.creates[0].parent).toEqual({ database_id: DB });
    expect(notion.creates[0].properties.Creator).toEqual({ title: [{ type: "text", text: { content: "Board Game Barrage" } }] });
    expect(notion.creates[0].properties.Status).toEqual({ select: { name: "Sent" } });
    expect(notion.creates[0].properties["Shipped from"]).toEqual({ select: { name: "Stockholm office" } });

    await get("/api/shipments", asStaff());
    expect(notion.queries.length).toBe(queriesBefore + 2);
  });

  test("bad input is a 400 in one plain sentence, and never reaches Notion", async () => {
    const creates = notion.creates.length;
    const cases: [unknown, string][] = [
      [{ ...GOOD, game: "Monopoly" }, "Game must be one of"],
      [{ ...GOOD, creator: "" }, "Creator is required."],
      [{ ...GOOD, sent: "2026-02-30" }, "Sent must be a real date"],
      [{ ...GOOD, logged_by: "" }, "Logged by is required"],
      [{ ...GOOD, tracking: "javascript:alert(1)" }, "Tracking must be an http or https address."],
      [[1, 2], "JSON object"],
      ["text", "JSON object"],
    ];
    for (const [input, sentence] of cases) {
      const res = await post("/api/shipments", input, asStaff());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(sentence);
    }
    expect(notion.creates).toHaveLength(creates);
  });

  test("a POST that is not JSON, or from another site, is refused like the ideas endpoint", async () => {
    const creates = notion.creates.length;
    const plain = await rawPost("/api/shipments", GOOD, { cookie: auth, "Content-Type": "text/plain" });
    expect(plain.status).toBe(415);
    const sibling = await post("/api/shipments", GOOD, { cookie: auth, Origin: `http://ideas.${new URL(base).hostname}` });
    expect(sibling.status).toBe(403);
    const other = await get("/api/shipments", { cookie: auth });
    expect(other.status).toBe(200);
    const put = await fetch(base + "/api/shipments", { method: "PUT", headers: asStaff() });
    expect(put.status).toBe(405);
    expect(notion.creates).toHaveLength(creates);
  });

  test("Notion falling over mid-write is a 502, not a 500 page", async () => {
    notion.mode = "500";
    const res = await post("/api/shipments", GOOD, asStaff());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("Notion answered 500");
    notion.mode = "ok";
  });
});
