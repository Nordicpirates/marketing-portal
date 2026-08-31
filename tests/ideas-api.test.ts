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
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SEED = JSON.parse(readFileSync(join(REPO, "data", "ideas.json"), "utf8"));

// This server's own state, so nothing here can touch another test file's store or the
// repo's ./state directory.
const SERVER_STATE = mkdtempSync(join(tmpdir(), "ideas-api-test-"));
const IDEAS_FILE = join(SERVER_STATE, "ideas.json");
const PASSWORD = "test-portal-password-4f21";

// This file imports lib/ideas-store.ts for its limit constants, and that module resolves
// STATE_DIR and creates it at import time. Point it at this file's own temp directory
// first, or importing it would make a state/ directory in the repo. Only if no other
// test file got there ahead of us: bun shares one module cache across the run, so the
// first file to import it fixes the path for everyone. The import is dynamic, in
// beforeAll, because a static one would hoist above this line and read the wrong value.
if (!process.env.STATE_DIR) process.env.STATE_DIR = SERVER_STATE;

let MAX_TITLE_CHARS: number;
let MAX_BODY_CHARS: number;

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

/**
 * A POST with exactly the headers given and nothing added. The `post` helper above puts
 * application/json on every request, which is the thing these tests need to vary.
 */
const rawPost = (path: string, body: unknown, headers: Record<string, string>) =>
  fetch(base + path, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });

/**
 * A sibling subdomain: same site, different origin, and the case the cookie really is
 * sent for. SameSite=Lax keeps the cookie off a cross-SITE request whatever the method,
 * so an unrelated domain never had it. A neighbour under the same registrable domain is
 * same-site, so it does, which is the gap the Origin check closes.
 */
const siblingOrigin = () => `http://ideas.${new URL(base).hostname}`;

/**
 * A request with byte-exact headers, which fetch cannot send.
 *
 * fetch encodes a header value as UTF-8 and the server reads header bytes as Latin-1, so
 * a U-label like "münchen.de" arrives as "mÃ¼nchen.de" and the test would be measuring
 * that mangling rather than the host comparison. A proxy writes the bytes it was
 * configured with, so this does the same.
 */
function rawRequest(requestLines: string[], body = ""): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(base);
    const socket = connect({ host: target.hostname, port: Number(target.port) }, () => {
      const head = [...requestLines, `Content-Length: ${Buffer.byteLength(body, "latin1")}`, "Connection: close", "", ""].join("\r\n");
      socket.write(Buffer.from(head + body, "latin1"));
    });

    let raw = "";
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error(`no answer to: ${requestLines[0]}`));
    });
    socket.on("data", (chunk) => (raw += chunk.toString("latin1")));
    socket.on("end", () => resolve({ status: Number(raw.slice(9, 12)), raw }));
    socket.on("error", reject);
  });
}

/** The headers every rawRequest below needs, so each test writes only what it varies. */
const rawCommon = () => [`Host: ${new URL(base).host}`, "Content-Type: application/json", `Cookie: ${auth}`];

const rawBody = (title: string) => JSON.stringify({ brand: "tap10", title, body: "Sent with byte-exact headers." });

async function ideas(): Promise<{ brands: any[]; ideas: any[] }> {
  const res = await get("/api/ideas", asStaff());
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  const store = await import("../lib/ideas-store.ts");
  MAX_TITLE_CHARS = store.MAX_TITLE_CHARS;
  MAX_BODY_CHARS = store.MAX_BODY_CHARS;

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

describe("a POST must come from the portal, and must say it is JSON", () => {
  // SameSite=Lax keeps the cookie off a cross-SITE request, form post or fetch alike,
  // so a page on an unrelated domain never had it. What Lax does not stop is a
  // same-site, cross-ORIGIN request: a sibling subdomain is same-site with this portal,
  // so the cookie rides along. Sending text/plain from there is a "simple" request, so
  // there is no preflight to fail either. That is the vector these close.
  const attempt = { brand: "tap10", title: "Should not land", body: "Sent from somewhere else" };

  test("same origin, application/json: the portal's own request still works", async () => {
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "Filed from the portal", body: "Typed in the browser on the portal itself." },
      { "content-type": "application/json", origin: base, cookie: auth }
    );
    expect(res.status).toBe(201);
    expect((await res.json()).idea.title).toBe("Filed from the portal");
  });

  test("a sibling origin sending text/plain is refused, and nothing is written", async () => {
    const before = await ideas();

    const res = await rawPost("/api/ideas", attempt, {
      "content-type": "text/plain;charset=UTF-8",
      origin: siblingOrigin(),
      cookie: auth,
    });
    expect(res.status).toBe(403);

    const after = await ideas();
    expect(after.ideas).toHaveLength(before.ideas.length);
    expect(after.ideas.some((i: any) => i.title === "Should not land")).toBe(false);
  });

  test("a foreign origin sending application/json is refused, and nothing is written", async () => {
    const before = await ideas();

    for (const origin of ["https://evil.example.com", "http://marketing.nordicpirate.com.evil.example.com", "null"]) {
      const res = await rawPost("/api/ideas", attempt, {
        "content-type": "application/json",
        origin,
        cookie: auth,
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain("Cross-site");
    }

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
  });

  test("same origin but text/plain is refused too, so the content type is its own gate", async () => {
    const before = await ideas();

    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", ""]) {
      const headers: Record<string, string> = { origin: base, cookie: auth };
      if (type) headers["content-type"] = type;
      const res = await rawPost("/api/ideas", attempt, headers);
      expect(res.status).toBe(415);
    }

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
  });

  test("no Origin at all is allowed, so a server side caller is not broken by this", async () => {
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "From a script", body: "curl sends no Origin header." },
      { "content-type": "application/json", cookie: auth }
    );
    expect(res.status).toBe(201);
  });

  test("the same origin spelled in a different case is still ours", async () => {
    // Host names are case insensitive. A comparison that is not would refuse this.
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "Shouty origin", body: "Same host, different case." },
      { "content-type": "application/json", origin: `http://LOCALHOST:${new URL(base).port}`, cookie: auth }
    );
    expect(res.status).toBe(201);
  });

  test("a proxy header carrying an explicit port still matches an Origin without one", async () => {
    // The live shape that would have refused every real add: the browser's Origin is
    // https://host with no port, and the proxy forwards host:443.
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "Explicit port", body: "The proxy said :443." },
      {
        "content-type": "application/json",
        origin: "https://marketing.nordicpirate.com",
        "x-forwarded-host": "marketing.nordicpirate.com:443",
        cookie: auth,
      }
    );
    expect(res.status).toBe(201);
  });

  test("a chained proxy list is read as its first entry, not as one long string", async () => {
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "Chained proxies", body: "Two hops, one header." },
      {
        "content-type": "application/json",
        origin: "https://marketing.nordicpirate.com",
        "x-forwarded-host": "marketing.nordicpirate.com, 10.0.0.5:8080",
        cookie: auth,
      }
    );
    expect(res.status).toBe(201);
  });

  test("an RFC 7239 Forwarded header counts as well as X-Forwarded-Host", async () => {
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "RFC 7239", body: "The standard spelling of the same thing." },
      {
        "content-type": "application/json",
        origin: "https://marketing.nordicpirate.com",
        forwarded: 'for=203.0.113.7;host=marketing.nordicpirate.com;proto=https',
        cookie: auth,
      }
    );
    expect(res.status).toBe(201);
  });

  test("Sec-Fetch-Site: same-origin is accepted even when no host here can match", async () => {
    // The shape no host comparison can survive: a proxy rewrote Host to something
    // internal and set no forwarding header, so the browser's Origin matches nothing
    // this process can see. The browser stating same-origin is the way through, and a
    // cross-site page cannot set that header.
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "Internal host", body: "Only Sec-Fetch-Site can vouch for this." },
      {
        "content-type": "application/json",
        origin: "https://marketing.nordicpirate.com",
        "sec-fetch-site": "same-origin",
        cookie: auth,
      }
    );
    expect(res.status).toBe(201);
  });

  test("Sec-Fetch-Site: same-site is NOT accepted, because that is the sibling subdomain", async () => {
    const before = await ideas();

    for (const site of ["same-site", "cross-site", "none"]) {
      const res = await rawPost("/api/ideas", attempt, {
        "content-type": "application/json",
        origin: siblingOrigin(),
        "sec-fetch-site": site,
        cookie: auth,
      });
      expect(res.status).toBe(403);
    }

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
  });

  test("a different port on the same host name counts as ours, which is the deliberate trade", async () => {
    // Ports are dropped before comparing, because TLS ends in front of this process and
    // the port seen here is never the port the browser used. The cost is that a
    // neighbour on another port of the SAME host name is treated as the portal. Host
    // names, which is what a hostile page actually differs by, still have to match.
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "Another port", body: "Same host name, different port." },
      {
        "content-type": "application/json",
        origin: `http://localhost:${Number(new URL(base).port) + 1}`,
        cookie: auth,
      }
    );
    expect(res.status).toBe(201);
  });

  test("behind a proxy, the Origin is matched against X-Forwarded-Host", async () => {
    // The live shape: TLS ends at the proxy, so the browser says https:// while this
    // server sees http://. Comparing whole origin strings would refuse the real portal.
    const res = await rawPost(
      "/api/ideas",
      { brand: "tap10", title: "Through the proxy", body: "https on the outside, http in here." },
      {
        "content-type": "application/json",
        origin: "https://marketing.nordicpirate.com",
        "x-forwarded-host": "marketing.nordicpirate.com",
        cookie: auth,
      }
    );
    expect(res.status).toBe(201);
  });

  test("IPv6 expanded and collapsed are one host, in either direction", async () => {
    // [0:0:0:0:0:0:0:1] and [::1] are the same address. Comparing the strings refuses a
    // request that came from the portal, which is what slicing the host by hand did.
    for (const [origin, xfh] of [
      ["https://[::1]", "[0:0:0:0:0:0:0:1]"],
      ["https://[0:0:0:0:0:0:0:1]", "[::1]"],
      ["https://[0:0:0:0:0:0:0:1]", "[0:0:0:0:0:0:0:1]:443"],
    ]) {
      const res = await rawPost(
        "/api/ideas",
        { brand: "tap10", title: `IPv6 ${xfh}`, body: "Expanded and collapsed are one host." },
        { "content-type": "application/json", origin, "x-forwarded-host": xfh, cookie: auth }
      );
      expect({ origin, xfh, status: res.status }).toEqual({ origin, xfh, status: 201 });
    }
  });

  test("an international name matches whichever label form each side uses", async () => {
    // A browser sends the A-label in Origin. A proxy sends whatever it was configured
    // with, which is often the name a person typed. Both spellings are one host.
    const forms = [
      ["https://xn--mnchen-3ya.de", "münchen.de"],
      ["https://münchen.de", "xn--mnchen-3ya.de"],
      ["https://MÜNCHEN.DE", "xn--mnchen-3ya.de"],
    ];

    for (const [origin, xfh] of forms) {
      const { status } = await rawRequest(
        ["POST /api/ideas HTTP/1.1", ...rawCommon(), `Origin: ${origin}`, `X-Forwarded-Host: ${xfh}`],
        rawBody(`IDN ${origin}`)
      );
      expect({ origin, xfh, status }).toEqual({ origin, xfh, status: 201 });
    }
  });

  test("an international name that is genuinely a different host is still refused", async () => {
    const { status } = await rawRequest(
      ["POST /api/ideas HTTP/1.1", ...rawCommon(), "Origin: https://xn--mnchen-3ya.de", "X-Forwarded-Host: köln.de"],
      rawBody("Different IDN host")
    );
    expect(status).toBe(403);
  });

  test("only a real host= token in Forwarded counts, not a parameter that ends in host", async () => {
    // "proto=https;xhost=evil.com" was read as a host of evil.com, which handed the check
    // to anything that could name its own host.
    const before = await ideas();

    for (const forwarded of [
      "proto=https;xhost=evil.example.com",
      "proto=https;ghost=evil.example.com",
      "for=203.0.113.7;myhost=evil.example.com",
      "xhost=evil.example.com",
    ]) {
      const res = await rawPost("/api/ideas", attempt, {
        "content-type": "application/json",
        origin: "https://evil.example.com",
        forwarded,
        cookie: auth,
      });
      expect({ forwarded, status: res.status }).toEqual({ forwarded, status: 403 });
    }

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
  });

  test("a real host= in Forwarded is read, quoted or not, with or without a port", async () => {
    for (const forwarded of [
      "host=marketing.nordicpirate.com",
      'host="marketing.nordicpirate.com"',
      'host="marketing.nordicpirate.com:443"',
      "for=203.0.113.7;host=marketing.nordicpirate.com;proto=https",
      "  host = marketing.nordicpirate.com ",
      'proto=https;host="marketing.nordicpirate.com"',
    ]) {
      const res = await rawPost(
        "/api/ideas",
        { brand: "tap10", title: `Forwarded ${forwarded}`, body: "A real host token." },
        { "content-type": "application/json", origin: "https://marketing.nordicpirate.com", forwarded, cookie: auth }
      );
      expect({ forwarded, status: res.status }).toEqual({ forwarded, status: 201 });
    }
  });

  test("GET is unchanged: a foreign origin and no content type still read the list", async () => {
    const res = await get("/api/ideas", { cookie: auth, origin: "https://evil.example.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect((await res.json()).ideas.length).toBeGreaterThan(0);
  });
});

describe("a body that is not a JSON object", () => {
  test("null, arrays, strings and numbers are refused with 400, and nothing is written", async () => {
    // Every one of these is valid JSON. `null` used to reach the store, where reading
    // .brand off it threw and the request answered 500.
    const before = await ideas();

    for (const body of [null, [], [{ brand: "tap10", title: "T", body: "B" }], "a string", 42, true]) {
      const res = await rawPost("/api/ideas", body, { "content-type": "application/json", cookie: auth });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("JSON object");
    }

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
  });

  test("a body that is not JSON at all is refused with 400, not 500", async () => {
    const before = await ideas();

    const res = await fetch(base + "/api/ideas", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth },
      body: "{ this is not json",
      redirect: "manual",
    });
    expect(res.status).toBe(400);

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
  });

  test("an empty object is still the store's own 400, naming the missing field", async () => {
    const res = await rawPost("/api/ideas", {}, { "content-type": "application/json", cookie: auth });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("brand");
  });
});

describe("size limits at the API", () => {
  test("a title at exactly the limit lands, one character more answers 413", async () => {
    const atLimit = await post(
      "/api/ideas",
      { brand: "tap10", title: "t".repeat(MAX_TITLE_CHARS), body: "A body" },
      asStaff()
    );
    expect(atLimit.status).toBe(201);

    const before = await ideas();
    const over = await post(
      "/api/ideas",
      { brand: "tap10", title: "t".repeat(MAX_TITLE_CHARS + 1), body: "A body" },
      asStaff()
    );
    expect(over.status).toBe(413);
    expect((await over.json()).error).toContain("title");

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
  });

  test("an over-long body answers 413 and writes nothing", async () => {
    const before = await ideas();
    const res = await post(
      "/api/ideas",
      { brand: "tap10", title: "A title", body: "b".repeat(MAX_BODY_CHARS + 1) },
      asStaff()
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("body");

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
  });

  test("a body near the server's 1 MB ceiling, which used to be storable, answers 413", async () => {
    const before = await ideas();
    const res = await post(
      "/api/ideas",
      { brand: "tap10", title: "A title", body: "x".repeat(900_000) },
      asStaff()
    );
    expect(res.status).toBe(413);

    expect((await ideas()).ideas).toHaveLength(before.ideas.length);
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

describe("a store file the server cannot read back", () => {
  // Every one of these is valid JSON, and none of them can be read as a list of ideas.
  // The first four get past the container and fail on a row, which is the case where a
  // reader used to throw while a writer carried on appending into the same file.
  const unreadable = [
    '{"ideas":[null]}',
    '{"ideas":[{"id":"this row has no other fields"}]}',
    '{"ideas":[{"id":7,"brand":"tap10","title":"t","body":"b","created_at":"x","created_by":"p"}]}',
    '{"ideas":["a string where a row should be"]}',
    '{"ideas":[[]]}',
    '{"ideas":{"legacy":{"title":"must survive"}}}',
    '{"ideas":"not an array"}',
    '{"ideas":null}',
    "{}",
    "[]",
    "null",
    "42",
  ];

  let saved: string | null = null;

  beforeAll(() => {
    saved = existsSync(IDEAS_FILE) ? readFileSync(IDEAS_FILE, "utf8") : null;
  });

  afterAll(() => {
    if (saved === null) {
      if (existsSync(IDEAS_FILE)) unlinkSync(IDEAS_FILE);
    } else {
      writeFileSync(IDEAS_FILE, saved);
    }
  });

  test("GET and POST agree on every unreadable shape, and neither writes", async () => {
    for (const bytes of unreadable) {
      writeFileSync(IDEAS_FILE, bytes);

      const read = await get("/api/ideas", asStaff());
      const write = await post(
        "/api/ideas",
        { brand: "tap10", title: "Should not land", body: "written over a file nobody can read" },
        asStaff()
      );

      // The two must not disagree. A reader that fails while a writer succeeds means the
      // store is accepting ideas into a file it can never show anybody.
      expect({ shape: bytes, get: read.status, post: write.status }).toEqual({
        shape: bytes,
        get: 503,
        post: 503,
      });
      expect(readFileSync(IDEAS_FILE, "utf8")).toBe(bytes);
    }
  });

  test("the 503 is one sentence and gives away nothing about the server", async () => {
    writeFileSync(IDEAS_FILE, '{"ideas":[null]}');

    const res = await get("/api/ideas", asStaff());
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.text();
    expect(JSON.parse(body).error).toBe("The ideas store is unavailable. This has been logged for an operator.");
    // Bun's own error page for an unhandled throw is tens of kilobytes of internals.
    expect(body.length).toBeLessThan(200);
    expect(body).not.toMatch(/\n/);

    for (const leak of [SERVER_STATE, REPO, "/home/", "/app/", "ideas-store", "server.ts", ".ts:", "Error:", "at ", "readStored", "JSON.parse", "stack"]) {
      expect(body).not.toContain(leak);
    }
  });

  test("a good file straight after is read normally, so nothing is left broken", async () => {
    writeFileSync(IDEAS_FILE, JSON.stringify({ ideas: [] }, null, 2));
    const res = await get("/api/ideas", asStaff());
    expect(res.status).toBe(200);
    expect((await res.json()).ideas).toHaveLength(6);
  });
});

describe("a seed file the server cannot read back", () => {
  // The store reads two files, and checking the rows of one and not the other is the same
  // defect twice. A single bad row in the committed seed used to make GET answer 503
  // while POST answered 201 and created the stored file from nothing.
  const SEED_PATH = join(REPO, "data", "ideas.json");
  let committed = "";

  beforeAll(() => {
    committed = readFileSync(SEED_PATH, "utf8");
  });

  // Belt and braces on top of the finally inside the test: this file must never be left
  // modified, whatever happens in between.
  afterAll(() => {
    if (readFileSync(SEED_PATH, "utf8") !== committed) writeFileSync(SEED_PATH, committed);
  });

  test("a bad seed row makes GET and POST agree, and no stored file is created", async () => {
    const savedStore = existsSync(IDEAS_FILE) ? readFileSync(IDEAS_FILE, "utf8") : null;
    if (existsSync(IDEAS_FILE)) unlinkSync(IDEAS_FILE);

    try {
      const seed = JSON.parse(committed);
      for (const badRow of [null, "a string row", { id: "only-an-id" }, 42]) {
        writeFileSync(SEED_PATH, JSON.stringify({ ...seed, ideas: [...seed.ideas, badRow] }, null, 2));

        const read = await get("/api/ideas", asStaff());
        const write = await post(
          "/api/ideas",
          { brand: "tap10", title: "Should not land", body: "the seed cannot be read" },
          asStaff()
        );

        expect({ row: JSON.stringify(badRow), get: read.status, post: write.status }).toEqual({
          row: JSON.stringify(badRow),
          get: 503,
          post: 503,
        });
        // The reported symptom: the refused POST used to create the stored file.
        expect(existsSync(IDEAS_FILE)).toBe(false);
      }
    } finally {
      writeFileSync(SEED_PATH, committed);
      if (savedStore !== null) writeFileSync(IDEAS_FILE, savedStore);
    }
  });

  test("the committed seed is back exactly as it was, and reads normally again", async () => {
    expect(readFileSync(SEED_PATH, "utf8")).toBe(committed);

    const res = await get("/api/ideas", asStaff());
    expect(res.status).toBe(200);
    expect((await res.json()).ideas.length).toBeGreaterThanOrEqual(6);
  });
});
