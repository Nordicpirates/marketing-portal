// The one cross-site guard in front of every portal POST, against a real server.
// What it guards and why: docs/CROSS-SITE.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SERVER_STATE = mkdtempSync(join(tmpdir(), "api-guard-test-"));
const TASKS_FILE = join(SERVER_STATE, "tasks.json");
const IDEAS_FILE = join(SERVER_STATE, "ideas.json");
const PASSWORD = "test-portal-password-7d3e";
const FOREIGN = "https://evil.example";

let proc: any = null;
let base = "";
let auth = "";

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
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`the server never answered /health on ${base}`);
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

/** A POST with exactly these headers and this body text, nothing added. */
const send = (path: string, body: string, headers: Record<string, string>, method = "POST") =>
  fetch(base + path, { method, headers, body, redirect: "manual" });

const tasksBytes = () => readFileSync(TASKS_FILE, "utf8");
const taskDone = (id: string) => JSON.parse(tasksBytes()).agency_tasks.find((t: any) => t.id === id).done;
const ideaCount = () => JSON.parse(readFileSync(IDEAS_FILE, "utf8")).ideas.length;

let taskId = "";

beforeAll(async () => {
  await start();
  auth = await login();

  // The first read writes tasks.json from the seed, so every test below has bytes to compare.
  const res = await fetch(`${base}/api/tasks`, { headers: { cookie: auth } });
  expect(res.status).toBe(200);
  taskId = (await res.json()).agency_tasks[0].id;
  expect(taskId).toBeTruthy();

  const seeded = await send("/api/ideas", JSON.stringify({ brand: "tap10", title: "Seed the store", body: "So ideas.json exists." }), {
    "content-type": "application/json",
    cookie: auth,
  });
  expect(seeded.status).toBe(201);
});

afterAll(async () => {
  if (!proc) return;
  proc.kill();
  await proc.exited;
});

describe("POST /api/tasks is guarded like every other portal write", () => {
  test("the reported attack, foreign Origin with text/plain, is 403 and writes nothing", async () => {
    const before = tasksBytes();
    const res = await send("/api/tasks", JSON.stringify({ id: taskId, done: !taskDone(taskId) }), {
      "content-type": "text/plain",
      origin: FOREIGN,
      cookie: auth,
    });
    expect(res.status).toBe(403);
    expect(tasksBytes()).toBe(before);
  });

  test("a foreign Origin with application/json is 403 and tasks.json is byte-for-byte unchanged", async () => {
    const before = tasksBytes();
    for (const origin of [FOREIGN, `http://tasks.${new URL(base).hostname}`, "null"]) {
      const res = await send("/api/tasks", JSON.stringify({ id: taskId, done: !taskDone(taskId) }), {
        "content-type": "application/json",
        origin,
        cookie: auth,
      });
      expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
      expect((await res.json()).error).toContain("Cross-site");
    }
    expect(tasksBytes()).toBe(before);
  });

  test("the portal's own Origin without application/json is 415 and writes nothing", async () => {
    const before = tasksBytes();
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", ""]) {
      const headers: Record<string, string> = { origin: base, cookie: auth };
      if (type) headers["content-type"] = type;
      const res = await send("/api/tasks", JSON.stringify({ id: taskId, done: !taskDone(taskId) }), headers);
      expect({ type, status: res.status }).toEqual({ type, status: 415 });
    }
    expect(tasksBytes()).toBe(before);
  });

  test("the portal's own Origin with application/json is 200 and the flag flips", async () => {
    const was = taskDone(taskId);
    const res = await send("/api/tasks", JSON.stringify({ id: taskId, done: !was }), {
      "content-type": "application/json",
      origin: base,
      cookie: auth,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).agency_tasks.find((t: any) => t.id === taskId).done).toBe(!was);
    expect(taskDone(taskId)).toBe(!was);
  });

  test("no Origin at all with application/json is 200, so a server-side caller still works", async () => {
    const was = taskDone(taskId);
    const res = await send("/api/tasks", JSON.stringify({ id: taskId, done: !was }), {
      "content-type": "application/json",
      cookie: auth,
    });
    expect(res.status).toBe(200);
    expect(taskDone(taskId)).toBe(!was);
  });

  test("GET with a foreign Origin is still 200 with the task list, uncached", async () => {
    const res = await fetch(`${base}/api/tasks`, { headers: { cookie: auth, origin: FOREIGN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect((await res.json()).agency_tasks.find((t: any) => t.id === taskId).done).toBe(taskDone(taskId));
  });

  test("a body missing done is the existing 400, and writes nothing", async () => {
    const before = tasksBytes();
    const res = await send("/api/tasks", JSON.stringify({ id: taskId }), { "content-type": "application/json", cookie: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "need id + done" });
    expect(tasksBytes()).toBe(before);
  });

  test("a JSON body that is not an object is the existing 400, never a 500, and writes nothing", async () => {
    const before = tasksBytes();
    for (const body of ["null", '"x"', "7", "[]", "{ not json"]) {
      const res = await send("/api/tasks", body, { "content-type": "application/json", origin: base, cookie: auth });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(await res.json()).toEqual({ error: "need id + done" });
    }
    expect(tasksBytes()).toBe(before);
  });

  test("no cookie is 401 ahead of the 403 and the 415, and writes nothing", async () => {
    const before = tasksBytes();
    for (const headers of [
      { "content-type": "text/plain", origin: FOREIGN },
      { "content-type": "application/json", origin: FOREIGN },
      { "content-type": "text/plain", origin: base },
      { "content-type": "application/json", origin: FOREIGN, cookie: "auth=" + "a".repeat(64) },
    ]) {
      const res = await send("/api/tasks", JSON.stringify({ id: taskId, done: !taskDone(taskId) }), headers);
      expect({ headers, status: res.status }).toEqual({ headers, status: 401 });
    }
    expect(tasksBytes()).toBe(before);
  });
});

describe("the checkboxes on / keep working", () => {
  test("public/index.html still sends the shape this test replays", () => {
    const page = readFileSync(join(REPO, "public", "index.html"), "utf8");
    expect(page).toContain(
      "fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,done})})"
    );
  });

  test("that same-origin request, as a browser sends it, is 200 and flips the flag both ways", async () => {
    const was = taskDone(taskId);
    for (const done of [!was, was]) {
      const res = await send("/api/tasks", JSON.stringify({ id: taskId, done }), {
        "Content-Type": "application/json",
        origin: base,
        "sec-fetch-site": "same-origin",
        cookie: auth,
      });
      expect(res.status).toBe(200);
      expect(taskDone(taskId)).toBe(done);
    }
  });
});

describe("one guard in the router, for POST only", () => {
  test("server.ts calls crossSiteRefusal from exactly one place", () => {
    const source = readFileSync(join(REPO, "server.ts"), "utf8");
    const calls = source.split("\n").filter((line) => line.includes("crossSiteRefusal(") && !line.includes("function crossSiteRefusal"));
    expect(calls).toHaveLength(1);
  });

  test("PUT and DELETE on ideas and shipments still reach their route and get 405", async () => {
    for (const path of ["/api/ideas", "/api/shipments"]) {
      for (const method of ["PUT", "DELETE"]) {
        const res = await send(path, "{}", { "content-type": "text/plain", origin: FOREIGN, cookie: auth }, method);
        expect({ path, method, status: res.status }).toEqual({ path, method, status: 405 });
      }
    }
  });

  test("a browser's preflight carries no cookie, so it gets the 401 and no CORS headers", async () => {
    for (const path of ["/api/tasks", "/api/ideas", "/api/shipments"]) {
      const res = await fetch(base + path, {
        method: "OPTIONS",
        headers: { origin: FOREIGN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
      expect([...res.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
    }
  });

  test("a POST to any other /api/ path passes the same guard", async () => {
    for (const path of ["/api/data", "/api/assets", "/api/not-a-route"]) {
      const foreign = await send(path, "{}", { "content-type": "application/json", origin: FOREIGN, cookie: auth });
      expect({ path, status: foreign.status }).toEqual({ path, status: 403 });
      const plain = await send(path, "{}", { "content-type": "text/plain", origin: base, cookie: auth });
      expect({ path, status: plain.status }).toEqual({ path, status: 415 });
    }
  });
});

describe("a trailing dot on the host is the same DNS name", () => {
  const idea = (title: string) => JSON.stringify({ brand: "tap10", title, body: "Trailing dot." });

  test("X-Forwarded-Host with the dot matches an Origin without it, and the reverse", async () => {
    for (const [origin, xfh] of [
      ["https://marketing.nordicpirate.com", "marketing.nordicpirate.com."],
      ["https://marketing.nordicpirate.com.", "marketing.nordicpirate.com"],
    ]) {
      const res = await send("/api/ideas", idea(`dot ${origin} ${xfh}`), {
        "content-type": "application/json",
        origin,
        "x-forwarded-host": xfh,
        cookie: auth,
      });
      expect({ origin, xfh, status: res.status }).toEqual({ origin, xfh, status: 201 });
    }
  });

  test("a genuinely different host is still 403, with or without the dot, and writes nothing", async () => {
    const before = ideaCount();
    for (const [origin, xfh] of [
      ["https://evil.example.com.", "marketing.nordicpirate.com"],
      ["https://evil.example.com", "marketing.nordicpirate.com."],
      ["https://marketing.nordicpirate.com.evil.example.com.", "marketing.nordicpirate.com"],
      ["https://marketing.nordicpirate.com..", "marketing.nordicpirate.com"],
    ]) {
      const res = await send("/api/ideas", idea("Should not land"), {
        "content-type": "application/json",
        origin,
        "x-forwarded-host": xfh,
        cookie: auth,
      });
      expect({ origin, xfh, status: res.status }).toEqual({ origin, xfh, status: 403 });
    }
    expect(ideaCount()).toBe(before);
  });
});
