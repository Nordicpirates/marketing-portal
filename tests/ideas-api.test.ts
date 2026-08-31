// The /ideas page and the /api/ideas verbs, against a real server.
//
// This file runs the manual verification block from issue #20 for real: it starts
// server.ts as a child process with its own STATE_DIR, logs in the way a person does
// (POST /login, keep the cookie), adds an idea, then STOPS THE SERVER AND STARTS IT
// AGAIN on the same directory. That restart is the redeploy, and the idea being there
// afterwards is the criterion this whole issue exists for.
//
// A child process rather than importing server.ts: the server calls Bun.serve() at
// import time and there is no handler to call directly, and only a separate process can
// be stopped and started again inside one test run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SEED = JSON.parse(readFileSync(join(REPO, "data", "ideas.json"), "utf8"));

// This server's own state, so nothing here can touch another test file's store or the
// repo's ./state directory.
const SERVER_STATE = mkdtempSync(join(tmpdir(), "ideas-api-test-"));
const IDEAS_FILE = join(SERVER_STATE, "ideas.json");
const PASSWORD = "test-portal-password-4f21";

let proc: any = null;
let base = "";

/** A port nobody is listening on, found by briefly taking one and giving it back. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function start(): Promise<void> {
  const port = freePort();
  base = `http://localhost:${port}`;
  proc = Bun.spawn({
    cmd: ["bun", "run", join(REPO, "server.ts")],
    env: { ...process.env, PORT: String(port), STATE_DIR: SERVER_STATE, AUTH_PASSWORD: PASSWORD },
    stdout: "pipe",
    stderr: "pipe",
  });

  for (let waited = 0; waited < 15000; waited += 50) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet. Nothing to report until the wait runs out.
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

/** Log in the way a person does, and hand back the cookie the browser would keep. */
async function login(): Promise<string> {
  const form = new FormData();
  form.set("password", PASSWORD);
  const res = await fetch(`${base}/login`, { method: "POST", body: form, redirect: "manual" });
  expect(res.status).toBe(302);

  const cookie = (res.headers.get("set-cookie") || "").match(/auth=[a-f0-9]{64}/);
  if (!cookie) throw new Error("POST /login did not set an auth cookie, so nothing below can be checked");
  return cookie[0];
}

let auth = "";

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers, redirect: "manual" });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
  });

const asStaff = () => ({ cookie: auth });

async function ideas(): Promise<{ brands: any[]; ideas: any[] }> {
  const res = await get("/api/ideas", asStaff());
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  await start();
  auth = await login();
});

afterAll(stop);

describe("the password gate covers ideas exactly like the rest of the portal", () => {
  test("a logged out visitor asking for /ideas is sent to /login", async () => {
    const res = await get("/ideas");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("both /api/ideas verbs answer 401 without a cookie, and the POST writes nothing", async () => {
    const before = existsSync(IDEAS_FILE) ? readFileSync(IDEAS_FILE, "utf8") : null;

    for (const headers of [{}, { cookie: "auth=" + "a".repeat(64) }, { cookie: "auth=nonsense" }]) {
      const read = await get("/api/ideas", headers);
      expect(read.status).toBe(401);
      expect(await read.text()).not.toContain("dishwasher");

      const write = await post("/api/ideas", { brand: "tap10", title: "Snuck in", body: "No cookie" }, headers);
      expect(write.status).toBe(401);
    }

    expect(existsSync(IDEAS_FILE) ? readFileSync(IDEAS_FILE, "utf8") : null).toBe(before);
  });
});

describe("the page and the list", () => {
  test("a logged in staff member gets the ideas page", async () => {
    const res = await get("/ideas", asStaff());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Marketing Ideas");
    // The brands and the ideas are fetched, never written into the page, so a third
    // brand is a data change with no edit here.
    expect(html).toContain("/api/ideas");
    expect(html).not.toContain("Lying Pirates</button>");
    for (const idea of SEED.ideas) expect(html).not.toContain(idea.title);
  });

  test("GET /api/ideas serves the seeded ideas and the brand list, uncached", async () => {
    const res = await get("/api/ideas", asStaff());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body.brands).toEqual(SEED.brands);
    expect(body.ideas).toHaveLength(6);
    expect(body.ideas.map((i: any) => i.title).sort()).toEqual(SEED.ideas.map((i: any) => i.title).sort());
  });
});

describe("adding an idea", () => {
  test("an unknown brand is refused with 400 and no row is written", async () => {
    const before = await ideas();

    for (const brand of ["nonsense", "", null, undefined, 7]) {
      const res = await post("/api/ideas", { brand, title: "Should not land", body: "Bad brand" }, asStaff());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("brand");
    }

    const after = await ideas();
    expect(after.ideas).toHaveLength(before.ideas.length);
    expect(after.ideas.some((i: any) => i.title === "Should not land")).toBe(false);
  });

  test("a good idea lands, is answered back, and is in the list straight away", async () => {
    const res = await post(
      "/api/ideas",
      { brand: "tap10", title: "Two cards, three seconds", body: "Which invention is older?" },
      asStaff()
    );
    expect(res.status).toBe(201);

    const created = (await res.json()).idea;
    expect(created.brand).toBe("tap10");
    expect(created.id).toBeTruthy();

    const list = (await ideas()).ideas;
    expect(list).toHaveLength(7);
    expect(list.find((i: any) => i.id === created.id)).toEqual(created);
  });

  test("an idea filed under one brand is not in the other brand's list", async () => {
    const list = (await ideas()).ideas;
    const tap = list.filter((i: any) => i.brand === "tap10");
    const lp = list.filter((i: any) => i.brand === "lying-pirates");

    expect(tap.some((i: any) => i.title === "Two cards, three seconds")).toBe(true);
    expect(lp.some((i: any) => i.title === "Two cards, three seconds")).toBe(false);
    expect(tap.length + lp.length).toBe(list.length);
  });
});

describe("a redeploy", () => {
  test("the idea added in the browser is still there, and the seed is not duplicated", async () => {
    const before = (await ideas()).ideas;
    const typed = before.find((i: any) => i.title === "Two cards, three seconds");
    expect(typed).toBeDefined();

    // The redeploy: the process goes away, the volume does not.
    await stop();
    await start();
    auth = await login();

    const after = (await ideas()).ideas;
    expect(after.find((i: any) => i.id === typed.id)).toEqual(typed);
    expect(after).toHaveLength(before.length);

    for (const seeded of SEED.ideas) {
      expect(after.filter((i: any) => i.id === seeded.id)).toHaveLength(1);
    }
  });

  test("and it survives a second one, so nothing is being rebuilt from the seed", async () => {
    const before = (await ideas()).ideas;
    await stop();
    await start();
    auth = await login();
    expect((await ideas()).ideas).toEqual(before);
  });
});
