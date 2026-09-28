// What the portal answers when a request or a file is wrong, against a real server.
// The rules these hold it to: docs/ERROR-ANSWERS.md and docs/PUBLIC-ROUTES.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SERVER_STATE = mkdtempSync(join(tmpdir(), "error-answers-test-"));
const TASKS_FILE = join(SERVER_STATE, "tasks.json");
const PASSWORD = "test-portal-password-e21b";
const COOKIE = `auth=${createHash("sha256").update("np-hq-" + PASSWORD).digest("hex")}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`;

let proc: any = null;
let logText = "";
let logDone: Promise<void> = Promise.resolve();
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
  logText = "";
  logDone = (async () => {
    for await (const chunk of proc.stderr) logText += new TextDecoder().decode(chunk);
  })();
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

/** Stop the server and hand back everything it wrote to stderr, which is where console.warn goes. */
async function stop(): Promise<string> {
  if (!proc) return "";
  proc.kill();
  await proc.exited;
  await logDone;
  proc = null;
  return logText;
}

/** Wait for a line to reach the server's stderr after `from`, and say whether it came. */
async function logged(line: string, from: number): Promise<boolean> {
  for (let waited = 0; waited < 2000; waited += 20) {
    if (logText.slice(from).includes(line)) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return false;
}

const REBUILT = `[tasks] ${TASKS_FILE} is not a task list, so it was read as empty and rebuilt from the seed`;

const form = (password: string) => {
  const body = new FormData();
  body.set("password", password);
  return body;
};

const login = (body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(`${base}/login`, { method: "POST", body, headers, redirect: "manual" });

const getTasks = () => fetch(`${base}/api/tasks`, { headers: { cookie: auth } });
const postTask = (id: string, done: boolean) =>
  fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie: auth },
    body: JSON.stringify({ id, done }),
  });

beforeAll(async () => {
  await start();
  const res = await login(form(PASSWORD));
  expect(res.status).toBe(302);
  auth = (res.headers.get("set-cookie") || "").match(/auth=[a-f0-9]{64}/)![0];
});

afterAll(stop);

describe("POST /login", () => {
  test("a correct form is still a 302 to / with exactly the same Set-Cookie", async () => {
    for (const password of [PASSWORD, `  ${PASSWORD.toUpperCase()} `]) {
      const res = await login(form(password));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("set-cookie")).toBe(COOKIE);
    }
  });

  test("a body that is not a form answers exactly what a wrong password answers", async () => {
    const wrong = await login(form("not-the-password"));
    expect(wrong.status).toBe(401);
    const wrongPage = await wrong.text();
    expect(wrongPage).toContain("Fel lösenord - försök igen.");

    for (const [body, type] of [
      [JSON.stringify({ password: PASSWORD }), "application/json"],
      [`password=${PASSWORD}`, "text/plain"],
      ["--x\r\nbroken", "multipart/form-data; boundary=x"],
      ["", ""],
    ]) {
      const res = await login(body, type ? { "content-type": type } : {});
      expect({ type, status: res.status }).toEqual({ type, status: 401 });
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("content-type")).toBe(wrong.headers.get("content-type"));
      expect(await res.text()).toBe(wrongPage);
    }
  });

  test("the login page carries no em dash or en dash", async () => {
    for (const res of [await fetch(`${base}/login`), await login(form("wrong"))]) {
      expect(await res.text()).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("/lp and /lp/ are public, like everything under /lp/", () => {
  test("logged out, /lp and /lp/ answer 404 and never redirect to /login", async () => {
    for (const path of ["/lp", "/lp/", "/lp/nope"]) {
      const res = await fetch(base + path, { redirect: "manual" });
      expect({ path, status: res.status, location: res.headers.get("location") }).toEqual({ path, status: 404, location: null });
    }
  });

  test("the gift page is still served, and a path merely starting with /lp still asks for a login", async () => {
    expect((await fetch(`${base}/lp/aboard/`, { redirect: "manual" })).status).toBe(200);
    const other = await fetch(`${base}/lpx`, { redirect: "manual" });
    expect(other.status).toBe(302);
    expect(other.headers.get("location")).toBe("/login");
  });
});

describe("a tasks.json that parses but is not a task list", () => {
  let rebuilt = "";
  let taskId = "";

  test("an unparseable file is read as empty and rebuilt from the seed, which is the baseline", async () => {
    writeFileSync(TASKS_FILE, "{ this does not parse");
    const res = await getTasks();
    expect(res.status).toBe(200);
    rebuilt = readFileSync(TASKS_FILE, "utf8");
    expect(await logged(REBUILT, 0)).toBe(true);
    taskId = (await res.json()).agency_tasks[0].id;
    expect(taskId).toBeTruthy();
  });

  const shapes = ["null", '"x"', "7", "[]", "{}", "true", '{"agency_tasks":null}', '{"agency_tasks":5}', '{"agency_tasks":"x"}'];
  for (const shape of shapes) {
    test(`content ${shape}: GET and POST are 200 and logged, exactly like the unparseable file`, async () => {
      writeFileSync(TASKS_FILE, shape);
      const from = logText.length;
      const read = await getTasks();
      expect(read.status).toBe(200);
      expect(readFileSync(TASKS_FILE, "utf8")).toBe(rebuilt);
      expect(await logged(REBUILT, from)).toBe(true);

      writeFileSync(TASKS_FILE, shape);
      const seedDone = JSON.parse(rebuilt).agency_tasks[0].done;
      const write = await postTask(taskId, !seedDone);
      expect(write.status).toBe(200);
      expect((await write.json()).agency_tasks[0].done).toBe(!seedDone);
    });
  }

  test("a task list holding a row that is not a task is a task list: 200, the row is skipped", async () => {
    writeFileSync(TASKS_FILE, '{"agency_tasks":[null]}');
    expect((await getTasks()).status).toBe(200);
    expect(readFileSync(TASKS_FILE, "utf8")).toBe(rebuilt);
  });

  test("a real task list keeps its done flags, logs nothing, so the merge itself is unchanged", async () => {
    writeFileSync(TASKS_FILE, rebuilt);
    const from = logText.length;
    const seedDone = JSON.parse(rebuilt).agency_tasks[0].done;
    expect((await postTask(taskId, !seedDone)).status).toBe(200);
    expect((await (await getTasks()).json()).agency_tasks[0].done).toBe(!seedDone);
    expect(await logged(REBUILT, from)).toBe(false);
  });
});

describe("the committed seed, which readTasks does not guard", () => {
  test("data/tasks.json parses and holds an agency_tasks array with a string id on every row", () => {
    const seed = JSON.parse(readFileSync(join(REPO, "data", "tasks.json"), "utf8"));
    expect(seed !== null && typeof seed === "object" && !Array.isArray(seed)).toBe(true);
    expect(Array.isArray(seed.agency_tasks)).toBe(true);
    expect(seed.agency_tasks.length).toBeGreaterThan(0);
    for (const [index, row] of seed.agency_tasks.entries()) {
      const id = row !== null && typeof row === "object" ? row.id : undefined;
      expect({ index, idIsText: typeof id === "string" && id.length > 0 }).toEqual({ index, idIsText: true });
    }
  });
});

describe("refusals leave a line in the log", () => {
  test("a bad tasks body, a non-form login and an unusable tasks file are all logged", async () => {
    const bad = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth },
      body: "null",
    });
    expect(bad.status).toBe(400);

    const log = await stop();
    expect(log).toContain("[tasks] refused a POST: the body needs an id and a boolean done");
    expect(log).toContain("[login] refused a POST: the body is not a form");
    expect(log).toContain(REBUILT);
    expect(log).not.toContain("TypeError");
  });
});
