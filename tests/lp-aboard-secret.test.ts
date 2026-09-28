// Both server-to-server secrets are read on every request through configuredSecret, never
// frozen at import, and an unset one still refuses everybody. docs/SERVER-SECRETS.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { configuredSecret } from "../lib/secret.ts";

const REPO = join(import.meta.dir, "..");
const SERVER_STATE = mkdtempSync(join(tmpdir(), "lp-aboard-secret-test-"));
const PROXY_WARNING = "[lp/aboard] LP_PROXY_SECRET is not set: EVERY claim will be refused with 403";
const ADMIN_WARNING = "[lp/aboard admin] LP_ADMIN_SECRET is not set: every request to /lp/aboard/signups";
const GOOD_CLAIM = JSON.stringify({ email: "crew@example.com", offer: "base-kraken", edition: "de" });
const SIGNUPS = "http://localhost/lp/aboard/signups";

if (!process.env.STATE_DIR) process.env.STATE_DIR = SERVER_STATE;

/** Run `body` with one env var set or removed, then put it back as it was. */
async function withEnv(name: string, value: string | undefined, body: () => Promise<void> | void) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("configuredSecret, the one reader both doors use", () => {
  const NAME = "LP_SECRET_READER_TEST_7c2f";

  test("it reads the environment at call time, trimmed", async () => {
    await withEnv(NAME, "  first-value  ", () => expect(configuredSecret(NAME)).toBe("first-value"));
    await withEnv(NAME, "second-value", () => expect(configuredSecret(NAME)).toBe("second-value"));
  });

  test("unset, empty or blank is the empty string, which secretMatches never accepts", async () => {
    for (const value of [undefined, "", "   "]) {
      await withEnv(NAME, value, () => expect({ value, read: configuredSecret(NAME) }).toEqual({ value, read: "" }));
    }
  });
});

describe("the real server with both secrets unset, as an unconfigured deploy", () => {
  let proc: any = null;
  let base = "";
  let stderr: Promise<string> = Promise.resolve("");

  beforeAll(async () => {
    const env: Record<string, string | undefined> = { ...process.env, PORT: "0", STATE_DIR: SERVER_STATE };
    delete env.LP_PROXY_SECRET;
    delete env.LP_ADMIN_SECRET;
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    env.PORT = String(probe.port);
    probe.stop(true);
    base = `http://localhost:${env.PORT}`;

    proc = Bun.spawn({ cmd: ["bun", "run", join(REPO, "server.ts")], env, stdout: "pipe", stderr: "pipe" });
    stderr = new Response(proc.stderr).text();
    for (let waited = 0; waited < 15000; waited += 50) {
      try {
        if ((await fetch(`${base}/health`)).ok) return;
      } catch {
        // Not up yet.
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`the server never answered /health on ${base}`);
  });

  afterAll(async () => {
    proc?.kill();
    await proc?.exited;
  });

  test("every claim is refused with 403, whatever secret it carries, and nothing is stored", async () => {
    for (const secret of [undefined, "", "a-guess", "test-proxy-secret"]) {
      const headers: Record<string, string> = { "content-type": "application/json", "x-visitor-ip": "203.0.113.9", "x-visitor-country": "US" };
      if (secret !== undefined) headers["x-lp-proxy-secret"] = secret;
      const res = await fetch(`${base}/lp/aboard/claim`, { method: "POST", headers, body: GOOD_CLAIM });
      expect({ secret, status: res.status }).toEqual({ secret, status: 403 });
      expect(await res.json()).toEqual({ error: "Not available here" });
    }
    expect(existsSync(join(SERVER_STATE, "lp-aboard-signups.jsonl"))).toBe(false);
  });

  test("both emailer routes are refused with 403, whatever secret they carry, and nothing is written", async () => {
    for (const secret of [undefined, "", "a-guess"]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (secret !== undefined) headers["x-lp-admin-secret"] = secret;
      const read = await fetch(`${base}/lp/aboard/signups`, { headers });
      const mark = await fetch(`${base}/lp/aboard/signups/mark-sent`, { method: "POST", headers, body: JSON.stringify({ events: ["x"] }) });
      expect({ secret, read: read.status, mark: mark.status }).toEqual({ secret, read: 403, mark: 403 });
      expect(await read.json()).toEqual({ error: "Not available here" });
    }
    expect(existsSync(join(SERVER_STATE, "lp-aboard-sent.jsonl"))).toBe(false);
  });

  test("both startup warnings are logged, and so is every refusal", async () => {
    proc.kill();
    await proc.exited;
    const log = await stderr;
    proc = null;
    expect(log).toContain(PROXY_WARNING);
    expect(log).toContain(ADMIN_WARNING);
    const count = (line: string) => log.split(line).length - 1;
    expect(count("[lp/aboard] claim rejected reason=unauthenticated")).toBe(4);
    expect(count("[lp/aboard admin] signups read rejected reason=unauthenticated")).toBe(3);
    expect(count("[lp/aboard admin] mark-sent rejected reason=unauthenticated")).toBe(3);
  });
});

describe("the claim, in this process, where the module was imported before the secret changed", () => {
  let handleClaim: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    handleClaim = (await import("../lib/lp-aboard.ts")).handleClaim;
  });

  // A bad email is refused with 400 after the secret check, so nothing is ever stored.
  const attempt = (secret: string, ip: string) =>
    handleClaim(
      new Request("http://localhost/lp/aboard/claim", {
        method: "POST",
        headers: { "content-type": "application/json", "x-lp-proxy-secret": secret, "x-visitor-ip": ip },
        body: JSON.stringify({ email: "not-an-address", offer: "base-kraken", edition: "de" }),
      })
    );

  test("a secret set after import is honoured on the next claim", async () => {
    await withEnv("LP_PROXY_SECRET", "set-after-import-5e1a", async () => {
      expect((await attempt("set-after-import-5e1a", "198.51.100.61")).status).toBe(400);
      expect((await attempt("a-wrong-secret", "198.51.100.62")).status).toBe(403);
    });
  });

  test("a secret removed after import refuses the next claim, so it still fails closed", async () => {
    await withEnv("LP_PROXY_SECRET", undefined, async () => {
      for (const secret of ["set-after-import-5e1a", ""]) {
        expect({ secret, status: (await attempt(secret, "198.51.100.63")).status }).toEqual({ secret, status: 403 });
      }
    });
  });
});

describe("the emailer's routes, in this process, where the module was imported before the secret changed", () => {
  let handleSignups: (req: Request) => Response;
  let handleMarkSent: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const admin = await import("../lib/lp-aboard-admin.ts");
    handleSignups = admin.handleSignups;
    handleMarkSent = admin.handleMarkSent;
  });

  // An empty events list is a valid mark-sent that writes nothing.
  const read = (secret: string) => handleSignups(new Request(SIGNUPS, { headers: { "x-lp-admin-secret": secret } }));
  const mark = (secret: string) =>
    handleMarkSent(
      new Request(`${SIGNUPS}/mark-sent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lp-admin-secret": secret },
        body: JSON.stringify({ events: [] }),
      })
    );

  test("a secret set after import is honoured on the next request, on both routes", async () => {
    await withEnv("LP_ADMIN_SECRET", "admin-set-after-import-3b9d", async () => {
      expect(read("admin-set-after-import-3b9d").status).toBe(200);
      expect((await mark("admin-set-after-import-3b9d")).status).toBe(200);
      expect(read("a-wrong-secret").status).toBe(403);
      expect((await mark("a-wrong-secret")).status).toBe(403);
    });
  });

  test("a secret removed after import refuses the next request, on both routes", async () => {
    await withEnv("LP_ADMIN_SECRET", undefined, async () => {
      for (const secret of ["admin-set-after-import-3b9d", ""]) {
        expect({ secret, read: read(secret).status, mark: (await mark(secret)).status }).toEqual({ secret, read: 403, mark: 403 });
      }
    });
  });
});
