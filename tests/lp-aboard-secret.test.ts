// The proxy secret is read on every claim, never frozen at import, and an unset one
// still refuses every claim. docs/GIFT-OFFER-WORKER.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SERVER_STATE = mkdtempSync(join(tmpdir(), "lp-aboard-secret-test-"));
const WARNING = "[lp/aboard] LP_PROXY_SECRET is not set: EVERY claim will be refused with 403";
const GOOD_CLAIM = JSON.stringify({ email: "crew@example.com", offer: "base-kraken", edition: "de" });

if (!process.env.STATE_DIR) process.env.STATE_DIR = SERVER_STATE;

describe("the real server with LP_PROXY_SECRET unset, as an unconfigured deploy", () => {
  let proc: any = null;
  let base = "";
  let stderr: Promise<string> = Promise.resolve("");

  beforeAll(async () => {
    const env: Record<string, string | undefined> = { ...process.env, PORT: "0", STATE_DIR: SERVER_STATE };
    delete env.LP_PROXY_SECRET;
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

  test("the startup warning is logged, and so is every refusal", async () => {
    proc.kill();
    await proc.exited;
    const log = await stderr;
    proc = null;
    expect(log).toContain(WARNING);
    expect(log.split("[lp/aboard] claim rejected reason=unauthenticated").length - 1).toBe(4);
  });
});

describe("in this process, where the module was imported before the secret changed", () => {
  const saved = process.env.LP_PROXY_SECRET;
  let handleClaim: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    handleClaim = (await import("../lib/lp-aboard.ts")).handleClaim;
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.LP_PROXY_SECRET;
    else process.env.LP_PROXY_SECRET = saved;
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
    process.env.LP_PROXY_SECRET = "set-after-import-5e1a";
    expect((await attempt("set-after-import-5e1a", "198.51.100.61")).status).toBe(400);
    expect((await attempt("a-wrong-secret", "198.51.100.62")).status).toBe(403);
  });

  test("a secret removed after import refuses the next claim, so it still fails closed", async () => {
    delete process.env.LP_PROXY_SECRET;
    for (const secret of ["set-after-import-5e1a", ""]) {
      expect({ secret, status: (await attempt(secret, "198.51.100.63")).status }).toEqual({ secret, status: 403 });
    }
  });
});
