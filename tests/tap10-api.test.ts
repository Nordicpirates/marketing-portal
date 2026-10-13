// GET /api/tap10 and /tap10 on a real server: no-cache, behind the login, and an empty
// list rather than a 404 before the first build. docs/TAP10.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FULL_ARGS, build } from "./tap10-fixture.ts";

const REPO = join(import.meta.dir, "..");
const PASSWORD = "test-portal-password-tap10";
const servers: any[] = [];

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** A server whose tap10.json is the given path, logged in. */
async function start(tap10Json: string): Promise<{ base: string; auth: string }> {
  const port = freePort();
  const base = `http://localhost:${port}`;
  servers.push(
    Bun.spawn({
      cmd: ["bun", "run", join(REPO, "server.ts")],
      env: {
        ...process.env, PORT: String(port), AUTH_PASSWORD: PASSWORD, TAP10_JSON: tap10Json,
        STATE_DIR: mkdtempSync(join(tmpdir(), "tap10-api-state-")),
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  for (let waited = 0; ; waited += 50) {
    if (waited > 15000) throw new Error(`the server never answered /health on ${base}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  const form = new FormData();
  form.set("password", PASSWORD);
  const res = await fetch(`${base}/login`, { method: "POST", body: form, redirect: "manual" });
  const cookie = (res.headers.get("set-cookie") || "").match(/auth=[a-f0-9]{64}/);
  if (!cookie) throw new Error("POST /login did not set an auth cookie");
  return { base, auth: cookie[0] };
}

const BUILT = build(FULL_ARGS);
let present = { base: "", auth: "" };
let missing = { base: "", auth: "" };

beforeAll(async () => {
  if (BUILT.code !== 0) throw new Error(`the builder refused the fixtures: ${BUILT.stderr}`);
  present = await start(BUILT.outPath);
  missing = await start(join(BUILT.dir, "not-built-yet.json"));
});

afterAll(async () => {
  for (const proc of servers) {
    proc.kill();
    await proc.exited;
  }
});

describe("GET /api/tap10", () => {
  test("serves the built file byte for byte, no-cache", async () => {
    const res = await fetch(`${present.base}/api/tap10`, { headers: { cookie: present.auth } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe(readFileSync(BUILT.outPath, "utf8"));
  });

  test("before the first build it is an empty list, never a 404, and still no-cache", async () => {
    const res = await fetch(`${missing.base}/api/tap10`, { headers: { cookie: missing.auth } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.json()).toEqual({ days: [] });
  });

  test("is behind the login like every other /api/ route", async () => {
    const res = await fetch(`${present.base}/api/tap10`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });
});

describe("GET /tap10", () => {
  test("is the TAP 10 page, no-cache", async () => {
    const res = await fetch(`${present.base}/tap10`, { headers: { cookie: present.auth } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(readFileSync(join(REPO, "public", "tap10.html"), "utf8"));
  });

  test("sends a visitor without a login to /login", async () => {
    const res = await fetch(`${present.base}/tap10`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
