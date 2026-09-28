// The staff login on the real server: no password in the source, unset refuses everything,
// and a cookie issued the old way still gets in. docs/SERVER-SECRETS.md, "The staff login"

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
// Built from parts so this file does not itself carry the old default.
const OLD_DEFAULT = "pirates" + "2024";
const PASSWORD = "Staff-Login-Pw-5e2c";
const WARNING = "[login] AUTH_PASSWORD is not set: every staff login will be refused with 401";

/** The token exactly as main computed it before this change, with nothing from server.ts. */
const oldWayToken = (password: string) => createHash("sha256").update("np-hq-" + password).digest("hex");
const oldWaySetCookie = (password: string) =>
  `auth=${oldWayToken(password)}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`;

/** Start server.ts with AUTH_PASSWORD as given (undefined removes it), and collect stderr. */
function server(authPassword: string | undefined) {
  const state = { proc: null as any, base: "", stderr: Promise.resolve("") };

  beforeAll(async () => {
    const env: Record<string, string | undefined> = { ...process.env, STATE_DIR: mkdtempSync(join(tmpdir(), "staff-login-test-")) };
    delete env.AUTH_PASSWORD;
    if (authPassword !== undefined) env.AUTH_PASSWORD = authPassword;
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    env.PORT = String(probe.port);
    probe.stop(true);
    state.base = `http://localhost:${env.PORT}`;

    state.proc = Bun.spawn({ cmd: ["bun", "run", join(REPO, "server.ts")], env, stdout: "pipe", stderr: "pipe" });
    state.stderr = new Response(state.proc.stderr).text();
    for (let waited = 0; waited < 15000; waited += 50) {
      try {
        if ((await fetch(`${state.base}/health`)).ok) return;
      } catch {
        // Not up yet.
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`the server never answered /health on ${state.base}`);
  });

  afterAll(async () => {
    state.proc?.kill();
    await state.proc?.exited;
  });

  const login = (password: string) => {
    const form = new FormData();
    form.set("password", password);
    return fetch(`${state.base}/login`, { method: "POST", body: form, redirect: "manual" });
  };
  const withCookie = (path: string, token: string) =>
    fetch(state.base + path, { headers: { cookie: `auth=${token}` }, redirect: "manual" });
  const stop = async () => {
    state.proc.kill();
    await state.proc.exited;
    state.proc = null;
    return state.stderr;
  };

  return { login, withCookie, stop };
}

test("no source file carries the old default password", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|js|html|css|json|md)$/.test(name) && readFileSync(full, "utf8").includes(OLD_DEFAULT)) found.push(full.slice(REPO.length + 1));
    }
  };
  walk(REPO);
  expect(found).toEqual([]);
});

for (const [label, value] of [
  ["unset", undefined],
  ["blank", "   "],
] as const) {
  describe(`AUTH_PASSWORD ${label}: nobody gets in`, () => {
    const s = server(value);

    test("every login answers the login page with 401 and no cookie", async () => {
      for (const password of [OLD_DEFAULT, "", "   "]) {
        const res = await s.login(password);
        expect({ password, status: res.status }).toEqual({ password, status: 401 });
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(await res.text()).toContain("Fel lösenord");
      }
    });

    test("a cookie from an empty password, or from the old default, is refused on a page and on the API", async () => {
      for (const token of [oldWayToken(""), oldWayToken(OLD_DEFAULT)]) {
        const page = await s.withCookie("/", token);
        expect({ token, status: page.status, location: page.headers.get("location") }).toEqual({ token, status: 302, location: "/login" });
        const api = await s.withCookie("/api/data", token);
        expect({ token, status: api.status }).toEqual({ token, status: 401 });
      }
    });

    test("the startup warning is logged", async () => {
      expect(await s.stop()).toContain(WARNING);
    });
  });
}

describe("AUTH_PASSWORD set: staff get in exactly as before", () => {
  // Surrounding spaces in the configured value are trimmed, exactly as main trimmed them.
  const s = server(`  ${PASSWORD}  `);

  test("the right password gives 302 to / and the same Set-Cookie main gave", async () => {
    const res = await s.login(PASSWORD);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toBe(oldWaySetCookie(PASSWORD));
  });

  test("upper case and surrounding spaces still log in, with the same cookie", async () => {
    for (const typed of [PASSWORD.toUpperCase(), PASSWORD.toLowerCase(), `  ${PASSWORD}  `, `\t${PASSWORD.toUpperCase()} `]) {
      const res = await s.login(typed);
      expect({ typed, status: res.status }).toEqual({ typed, status: 302 });
      expect(res.headers.get("set-cookie")).toBe(oldWaySetCookie(PASSWORD));
    }
  });

  test("a wrong password, the old default or an empty one gives 401 and no cookie", async () => {
    for (const typed of ["wrong", `${PASSWORD}x`, PASSWORD.slice(0, -1), OLD_DEFAULT, ""]) {
      const res = await s.login(typed);
      expect({ typed, status: res.status }).toEqual({ typed, status: 401 });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("a cookie computed the old way, from the same password, is accepted on a page and on the API", async () => {
    const token = oldWayToken(PASSWORD);
    expect((await s.withCookie("/", token)).status).toBe(200);
    expect((await s.withCookie("/api/data", token)).status).toBe(200);
  });

  test("a tampered cookie, a lowercased-password cookie or an empty-password cookie is refused", async () => {
    const good = oldWayToken(PASSWORD);
    const tampered = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    for (const token of [tampered, oldWayToken(PASSWORD.toLowerCase()), oldWayToken(""), oldWayToken(OLD_DEFAULT)]) {
      expect({ token, status: (await s.withCookie("/api/data", token)).status }).toEqual({ token, status: 401 });
      expect({ token, status: (await s.withCookie("/", token)).status }).toEqual({ token, status: 302 });
    }
  });

  test("no startup warning when the password is set", async () => {
    expect(await s.stop()).not.toContain(WARNING);
  });
});
