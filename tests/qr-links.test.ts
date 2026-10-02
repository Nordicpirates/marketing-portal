// Counted QR links end to end: the edge redirect, the secret door, the scan log and the
// numbers the /qr page draws. docs/QR-LINKS.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { lastDays, qrStats, readRegistry, scanFromHit, stockholmDay, type Scan } from "../lib/qr-links.ts";
import * as edge from "../edge/qr/functions/[[path]].js";
import { loadPortalPage } from "./portal-harness.ts";

const REPO = join(import.meta.dir, "..");
const REGISTRY = readRegistry();
const LINK = REGISTRY.links[0];
const SECRET = "test-qr-hit-secret-41c9";
const PASSWORD = "test-portal-password-qr";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

const scan = (at: string, extra: Partial<Scan> = {}): Scan => ({
  slug: LINK.slug, at, country: "SE", device: "ios", visitor: "0123456789abcdef", test: false, ...extra,
});

describe("the registry", () => {
  test("every counted slug is lowercase, unique, and goes somewhere with utm_medium=qr", () => {
    const slugs = REGISTRY.links.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const l of REGISTRY.links) {
      expect(l.slug).toMatch(/^[a-z0-9-]+$/);
      expect(new URL(l.destination).searchParams.get("utm_medium")).toBe("qr");
    }
    expect(REGISTRY.base).toBe("https://qr.nordicpirates.com");
  });
});

describe("Stockholm days", () => {
  test("a scan at 23:30 UTC belongs to the next Stockholm day in summer", () => {
    expect(stockholmDay(new Date("2026-10-01T22:30:00Z"))).toBe("2026-10-02");
    expect(stockholmDay(new Date("2026-10-01T21:59:00Z"))).toBe("2026-10-01");
  });

  test("the last 30 days end today and run oldest first across a month end", () => {
    const days = lastDays(new Date("2026-10-02T10:00:00Z"), 30);
    expect(days).toHaveLength(30);
    expect(days[29]).toBe("2026-10-02");
    expect(days[0]).toBe("2026-09-03");
  });
});

describe("what a hit becomes", () => {
  const at = new Date("2026-10-02T10:00:00Z");

  test("an unknown slug is refused", () => {
    expect(scanFromHit({ slug: "nope" }, REGISTRY, at)).toEqual({ ok: false, error: "unknown slug" });
  });

  test("anything that is not an object is refused", () => {
    for (const body of [null, [], "window", 3]) expect(scanFromHit(body, REGISTRY, at).ok).toBe(false);
  });

  test("odd fields are coerced to their known shape, never stored as sent", () => {
    const r = scanFromHit({ slug: LINK.slug, country: "<b>", device: "fridge", visitor: "x", test: "yes" }, REGISTRY, at);
    expect(r).toEqual({ ok: true, scan: { slug: LINK.slug, at: at.toISOString(), country: "XX", device: "other", visitor: "", test: false } });
  });
});

describe("the numbers", () => {
  const now = new Date("2026-10-02T10:00:00Z");

  test("today, the last 7 days, the 30-day series and the total all agree", () => {
    const stats = qrStats(REGISTRY, [
      scan("2026-10-02T08:00:00Z"),
      scan("2026-10-01T22:30:00Z"),
      scan("2026-09-27T12:00:00Z", { visitor: "1111111111111111" }),
      scan("2026-09-20T12:00:00Z", { country: "DE", device: "android", visitor: "2222222222222222" }),
      scan("2026-07-01T12:00:00Z", { visitor: "3333333333333333" }),
    ], now);
    const l = stats.links.find((x) => x.slug === LINK.slug)!;
    expect(l.total).toBe(5);
    expect(l.today).toBe(2);
    expect(l.last7).toBe(3);
    expect(l.last30).toBe(4);
    expect(l.daily[29]).toBe(2);
    expect(l.daily.reduce((a, b) => a + b, 0)).toBe(4);
    expect(l.countries).toEqual([{ code: "SE", scans: 4 }, { code: "DE", scans: 1 }]);
    expect(l.devices).toEqual({ ios: 4, android: 1, other: 0 });
    expect(l.first_scan).toBe("2026-07-01T12:00:00Z");
    expect(l.last_scan).toBe("2026-10-02T08:00:00Z");
    expect(l.url).toBe(`https://qr.nordicpirates.com/${LINK.slug}`);
    expect(l.files.pdf).toBe(`https://qr.nordicpirates.com/files/${LINK.slug}.pdf`);
  });

  test("one phone scanning twice on one day is one unique, and twice on two days is two", () => {
    const stats = qrStats(REGISTRY, [
      scan("2026-10-02T08:00:00Z"),
      scan("2026-10-02T09:00:00Z"),
      scan("2026-10-01T09:00:00Z"),
      scan("2026-10-01T09:30:00Z", { visitor: "" }),
    ], now);
    const l = stats.links[0];
    expect(l.total).toBe(4);
    expect(l.unique).toBe(3);
  });

  test("a test scan is never counted, only its time is shown", () => {
    const stats = qrStats(REGISTRY, [scan("2026-10-02T09:00:00Z", { test: true })], now);
    expect(stats.links[0].total).toBe(0);
    expect(stats.links[0].last_test).toBe("2026-10-02T09:00:00Z");
  });

  test("a scan for a slug no longer in the registry is ignored, not thrown", () => {
    const stats = qrStats(REGISTRY, [scan("2026-10-02T09:00:00Z", { slug: "gone" })], now);
    expect(stats.links[0].total).toBe(0);
  });
});

describe("the edge", () => {
  const sent: { url: string; init: any }[] = [];
  const realFetch = globalThis.fetch;

  async function hit(path: string, init: { method?: string; headers?: Record<string, string> } = {}, secret = SECRET) {
    const waits: Promise<unknown>[] = [];
    const request: any = new Request(`https://qr.nordicpirates.com${path}`, { method: init.method || "GET", headers: init.headers || {} });
    request.cf = { country: "SE" };
    globalThis.fetch = (async (url: string, opts: any) => {
      sent.push({ url, init: opts });
      return new Response(null, { status: 204 });
    }) as any;
    try {
      const res = await edge.onRequest({ request, env: { QR_HIT_SECRET: secret }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
      return res;
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("a registered slug redirects to its destination, uncached, and reports one scan", async () => {
    sent.length = 0;
    const res = await hit(`/${LINK.slug}`, { headers: { "user-agent": IPHONE, "cf-connecting-ip": "203.0.113.9" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(LINK.destination);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://marketing.nordicpirate.com/qr/hit");
    expect(sent[0].init.headers["x-qr-hit-secret"]).toBe(SECRET);
    const body = JSON.parse(sent[0].init.body);
    expect(body).toMatchObject({ slug: LINK.slug, country: "SE", device: "ios", test: false });
    expect(body.visitor).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(body)).not.toContain("203.0.113.9");
  });

  test("the slug is matched without case or trailing slash", async () => {
    const res = await hit(`/${LINK.slug.toUpperCase()}/`, { headers: { "user-agent": IPHONE } });
    expect(res.headers.get("location")).toBe(LINK.destination);
  });

  test("an unknown path or the bare host lands on the store, and reports nothing", async () => {
    sent.length = 0;
    for (const path of ["/", "/nope", "/files"]) {
      const res = await hit(path, { headers: { "user-agent": IPHONE } });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://www.nordicpirates.com/");
    }
    expect(sent).toHaveLength(0);
  });

  test("a bot, a link preview, a prefetch, a HEAD and an empty user agent redirect but are not counted", async () => {
    sent.length = 0;
    const cases = [
      { headers: { "user-agent": "WhatsApp/2.23.20.0" } },
      { headers: { "user-agent": "facebookexternalhit/1.1" } },
      { headers: { "user-agent": "curl/8.5.0" } },
      { headers: { "user-agent": IPHONE, "sec-purpose": "prefetch" } },
      { method: "HEAD", headers: { "user-agent": IPHONE } },
      { headers: {} },
    ];
    for (const c of cases) {
      const res = await hit(`/${LINK.slug}`, c);
      expect(res.headers.get("location")).toBe(LINK.destination);
    }
    expect(sent).toHaveLength(0);
  });

  test("?test=1 is reported as a test", async () => {
    sent.length = 0;
    await hit(`/${LINK.slug}?test=1`, { headers: { "user-agent": IPHONE } });
    expect(JSON.parse(sent[0].init.body).test).toBe(true);
  });

  test("with no secret on the edge it still redirects and sends nothing", async () => {
    sent.length = 0;
    const res = await hit(`/${LINK.slug}`, { headers: { "user-agent": IPHONE } }, "");
    expect(res.headers.get("location")).toBe(LINK.destination);
    expect(sent).toHaveLength(0);
  });

  test("the same phone on the same day hashes the same, and another day does not", async () => {
    const a = await edge.visitorHash(SECRET, "203.0.113.9", IPHONE, "2026-10-02");
    expect(await edge.visitorHash(SECRET, "203.0.113.9", IPHONE, "2026-10-02")).toBe(a);
    expect(await edge.visitorHash(SECRET, "203.0.113.9", IPHONE, "2026-10-03")).not.toBe(a);
  });

  test("the edge hashes with the same Stockholm day the portal counts with", () => {
    // A UTC day would split one phone into two between midnight and 02:00 Stockholm time.
    const src = readFileSync(join(REPO, "edge", "qr", "functions", "[[path]].js"), "utf8");
    expect(src).toContain('import { stockholmDay } from "../../../lib/stockholm-day.js";');
    expect(src).toContain("stockholmDay(new Date())");
    expect(src).not.toContain("toISOString().slice(0, 10)");
  });

  test("the print files and robots.txt are kept away from the Function", () => {
    const routes = JSON.parse(readFileSync(join(REPO, "edge", "qr", "public", "_routes.json"), "utf8"));
    expect(routes.exclude).toEqual(["/files/*", "/robots.txt"]);
  });
});

describe("the portal, as a real server", () => {
  const state = mkdtempSync(join(tmpdir(), "qr-links-test-"));
  const scansFile = join(state, "qr-scans.jsonl");
  let proc: any = null;
  let base = "";
  let cookie = "";

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    base = `http://localhost:${port}`;
    proc = Bun.spawn({
      cmd: ["bun", "run", join(REPO, "server.ts")],
      env: { ...process.env, PORT: String(port), STATE_DIR: state, AUTH_PASSWORD: PASSWORD, QR_HIT_SECRET: SECRET },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let waited = 0; waited < 15000; waited += 50) {
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
    cookie = ((res.headers.get("set-cookie") || "").match(/auth=[a-f0-9]{64}/) || [""])[0];
  });

  afterAll(() => proc?.kill());

  const post = (body: unknown, secret = SECRET) =>
    fetch(`${base}/qr/hit`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-qr-hit-secret": secret } : {}) },
      body: JSON.stringify(body),
      redirect: "manual",
    });

  test("no secret or the wrong one is 403 and stores nothing", async () => {
    expect((await post({ slug: LINK.slug }, "")).status).toBe(403);
    expect((await post({ slug: LINK.slug }, "wrong")).status).toBe(403);
    expect(existsSync(scansFile)).toBe(false);
  });

  test("an unknown slug is 400 and stores nothing", async () => {
    expect((await post({ slug: "nope" })).status).toBe(400);
    expect(existsSync(scansFile)).toBe(false);
  });

  test("a GET with the secret is 405", async () => {
    const res = await fetch(`${base}/qr/hit`, { headers: { "x-qr-hit-secret": SECRET } });
    expect(res.status).toBe(405);
  });

  test("a good hit is 204, one line on the volume, and shows in /api/qr", async () => {
    const res = await post({ slug: LINK.slug, country: "NO", device: "android", visitor: "abcdefabcdefabcd" });
    expect(res.status).toBe(204);
    const lines = readFileSync(scansFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ slug: LINK.slug, country: "NO", device: "android", test: false });

    const stats = await (await fetch(`${base}/api/qr`, { headers: { cookie } })).json();
    const l = stats.links.find((x: any) => x.slug === LINK.slug);
    expect(l.total).toBe(1);
    expect(l.today).toBe(1);
    expect(stats.direct.length).toBe(REGISTRY.direct.length);
  });

  test("the numbers and the page stay behind the staff password", async () => {
    expect((await fetch(`${base}/api/qr`)).status).toBe(401);
    const page = await fetch(`${base}/qr`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    const inside = await fetch(`${base}/qr`, { headers: { cookie } });
    expect(inside.status).toBe(200);
    expect(await inside.text()).toContain("QR codes");
  });

  test("/api/qr takes no writes", async () => {
    const res = await fetch(`${base}/api/qr`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(405);
  });
});

describe("the /qr page", () => {
  const now = new Date();
  const stats = (scans: Scan[]) => JSON.parse(JSON.stringify(qrStats(REGISTRY, scans, now)));

  test("with no scans it says so, and lists the older codes", async () => {
    const page = await loadPortalPage("qr.html", { "/api/qr": stats([]) });
    expect(page.errors).toEqual([]);
    expect(page.text("links")).toContain("No scans yet");
    expect(page.text("summary")).toContain("0 scans");
    expect(page.text("direct")).toContain(REGISTRY.direct[0].name);
  });

  test("with scans it shows the total, a column per day and the table", async () => {
    const page = await loadPortalPage("qr.html", { "/api/qr": stats([scan(now.toISOString()), scan(now.toISOString())]) });
    expect(page.errors).toEqual([]);
    expect(page.text(`total-${LINK.slug}`)).toBe("2");
    expect(page.document.querySelectorAll(`#chart-${LINK.slug} .hit`).length).toBe(30);
    expect(page.document.querySelectorAll(`#chart-${LINK.slug} .bar`).length).toBe(1);
    expect(page.text(`qr-${LINK.slug}`)).toContain("Show as table");
  });

  test("a name with markup is shown as text, never run", async () => {
    const data = stats([]);
    data.links[0].name = '<img src=x onerror="alert(1)">';
    const page = await loadPortalPage("qr.html", { "/api/qr": data });
    expect(page.document.querySelector(`#qr-${LINK.slug} img[onerror]`)).toBeNull();
  });
});
