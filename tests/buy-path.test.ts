// Landing pages by name, and the buy-path test's two pairs on Marketing HQ. The Python half
// runs on hand-made rows, never on real pulls; the page half through tests/portal-harness.ts.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPortalPage, snapshotWith } from "./portal-harness.ts";

const REPO = join(import.meta.dir, "..");
const NAMES = JSON.parse(readFileSync(join(REPO, "data", "landing-page-names.json"), "utf8"));
const EXPERIMENTS = JSON.parse(readFileSync(join(REPO, "data", "experiments.json"), "utf8"));
const TASKS = JSON.parse(readFileSync(join(REPO, "data", "tasks.json"), "utf8"));

// The 29 entries of the NAMES dict ga_landing_pages.py carried before the names file, unchanged.
const MIGRATED: [string, string][] = [
  ["/", "Homepage"],
  ["/products/lying-pirates-base-game", "Base Game (product)"],
  ["/products/lying-pirates-big-box", "Big Box (product)"],
  ["/products/lying-pirates-upgrade-box", "Upgrade Box (product)"],
  ["/products/lying-pirates-custom-insert", "Custom Insert (product)"],
  ["/products/gold-coins-20-pcs", "Gold Coins (product)"],
  ["/products/lying-pirates-cities-of-greed", "Cities of Greed (product)"],
  ["/pages/newslettersignup", "Newsletter signup"],
  ["/pages/faq", "FAQ"],
  ["/pages/about-us", "About us"],
  ["/pages/contact", "Contact"],
  ["/collections/all", "All products"],
  ["/search", "Search"],
  ["/cart", "Cart"],
  ["/gift-offer", "Gift offer (LP)"],
  ["/lp/lying-pirates-cities-of-greed-big-box", "CoG Big Box LP (A)"],
  ["/lp/lying-pirates-cities-of-greed-big-box-b", "CoG Big Box LP (B)"],
  ["/lp/play", "Big Box LP (play)"],
  ["/lp/lying-pirates-it", "Lying Pirates LP (IT)"],
  ["/lp/lying-pirates-cities-of-greed-big-box-it", "CoG Big Box LP (A, IT)"],
  ["/lp/lying-pirates-cities-of-greed-big-box-b-it", "CoG Big Box LP (B, IT)"],
  ["/lp/lying-pirates-cities-of-greed-big-box-de", "CoG Big Box LP (A, DE)"],
  ["/lp/lying-pirates-cities-of-greed-big-box-b-de", "CoG Big Box LP (B, DE)"],
  ["/products/cities-of-greed", "Cities of Greed (product)"],
  ["/products/kraken-mini-expansion", "Kraken Mini (product)"],
  ["/collections", "Collections"],
  ["/collections/lying-pirates", "Lying Pirates (collection)"],
  ["/pages/sticker-fix", "Sticker fix"],
  ["/blogs/news", "Blog"],
];

const ADDED: [string, string][] = [
  ["/lp/v2", "Dark checkout"], ["/lp/v3", "Dark cart"], ["/lp/Q4", "Light checkout"], ["/lp/Q4v2", "Light cart"],
  ["/lp/dark", "Dark split entry"], ["/lp/light", "Light split entry"], ["/lp/offer", "Campaign (all markets)"],
  ["/lp/offer-us", "Campaign US"], ["/lp/offer-eu", "Campaign EU"], ["/lp/offer-uk", "Campaign UK"],
  ["/lp/offer-au", "Campaign AU"], ["/lp/lying-pirates-cities-of-greed-big-box-c", "Big Box C (old dark)"],
];

/** Run Python against the repo's scripts and read back the JSON it prints. */
function py(code: string): any {
  const prelude = `import sys, json; sys.path.insert(0, ${JSON.stringify(join(REPO, "scripts"))})\n`;
  const run = Bun.spawnSync(["python3", "-I", "-c", prelude + code], { cwd: REPO });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

const page = (snapshot: any) =>
  loadPortalPage("index.html", { "/api/data": snapshot, "/api/experiments": EXPERIMENTS, "/api/tasks": TASKS });

const arm = (arm: string, name: string, path: string, sessions: number, orders: number, revenue: number) => ({
  arm, name, path, sessions, ga_purchases: 1, orders, revenue_eur: revenue,
  conv_pct: sessions ? Math.round((orders / sessions) * 10000) / 100 : null,
  eur_per_100: sessions ? Math.round((revenue / sessions) * 10000) / 100 : null,
});

const BLOCK = {
  note: "Orders carry the page's own tag; visits are Google Analytics sessions.",
  windows: {
    test: {
      start: "2026-10-07", end: "2026-10-18",
      arms: [
        arm("dark_checkout", "Dark checkout", "/lp/v2", 612, 10, 951.82),
        arm("dark_cart", "Dark cart", "/lp/v3", 598, 8, 950.03),
        arm("light_checkout", "Light checkout", "/lp/Q4", 728, 9, 934.56),
        arm("light_cart", "Light cart", "/lp/Q4v2", 680, 8, 845.48),
      ],
      campaign: [{ arm: "campaign_eu_3for2", orders: 4, revenue_eur: 161.16 }],
    },
    "7d": {
      start: "2026-10-12", end: "2026-10-18",
      arms: [
        arm("dark_checkout", "Dark checkout", "/lp/v2", 421, 7, 712.71),
        arm("dark_cart", "Dark cart", "/lp/v3", 403, 4, 398.2),
        arm("light_checkout", "Light checkout", "/lp/Q4", 458, 4, 503.11),
        arm("light_cart", "Light cart", "/lp/Q4v2", 0, 0, 0),
      ],
      campaign: [],
    },
  },
};

const withBlock = (block: any) =>
  snapshotWith((s) => {
    s.buy_path = block;
    s.sources.buy_path = { as_of: "2026-10-18", pulled: "2026-10-19" };
  });

describe("the buy-path section", () => {
  test("two cards, dark then light, each with its checkout and cart by name, path and numbers", async () => {
    const p = await page(withBlock(BLOCK));
    expect(p.shown("bp-section")).toBe(true);
    const cards = [...p.el("bp-grid").querySelectorAll(".bp-card")];
    expect(cards.map((c: any) => c.querySelector("h3").textContent)).toEqual(["Dark", "Light"]);
    expect(cards.map((c: any) => [...c.querySelectorAll(".bp-name")].map((n: any) => n.textContent))).toEqual([
      ["Dark checkout", "Dark cart"],
      ["Light checkout", "Light cart"],
    ]);
    for (const a of BLOCK.windows.test.arms) {
      const row = p.el("bp-grid").querySelector(`[data-arm="${a.arm}"]`);
      const text = row.textContent.replace(/\s+/g, " ");
      expect(row.querySelector(".bp-path").textContent).toBe(a.path);
      expect(text).toContain(a.sessions.toLocaleString("en-US"));
      expect(text).toContain(`${a.orders}orders`);
      expect(text).toContain(`${a.conv_pct!.toFixed(2)}%`);
      expect(text).toContain(`€${a.eur_per_100!.toFixed(2)}`);
    }
    expect(p.errors).toEqual([]);
  });

  test("the last seven days sit on a second line, and no visits reads as a hyphen, not a zero rate", async () => {
    const p = await page(withBlock(BLOCK));
    const dark = p.el("bp-grid").querySelector('[data-arm="dark_checkout"] .bp-7d').textContent;
    expect(dark).toContain("Last 7 days: 421 sessions · 7 orders · 1.66% · €169.29 per 100");
    const empty = p.el("bp-grid").querySelector('[data-arm="light_cart"] .bp-7d').textContent;
    expect(empty).toContain("0 sessions · 0 orders · - · - per 100");
    expect(empty).not.toContain("0.00%");
  });

  test("the caption carries both windows' dates, and the note and other tags are shown", async () => {
    const p = await page(withBlock(BLOCK));
    expect(p.text("bp-caption")).toContain("7 Oct → 18 Oct");
    expect(p.text("bp-caption")).toContain("12 Oct → 18 Oct");
    expect(p.text("bp-note")).toContain(BLOCK.note);
    expect(p.text("bp-note")).toContain("campaign_eu_3for2 4 orders €161.16");
    expect(p.text("fr-bp")).toContain("Buy-path test");
    expect(p.text("fr-bp")).toContain("18 Oct");
  });

  test("a snapshot without the block hides the section and says nothing false", async () => {
    const p = await page(snapshotWith((s) => delete s.buy_path));
    expect(p.shown("bp-section")).toBe(false);
    expect(p.errors).toEqual([]);
  });
});

describe("landing pages by name", () => {
  test("a row takes its name from the names file, keeps its path, and an unknown path is its own name", () => {
    const rows = py(`
import lp_names, ga_landing_pages as g
names = lp_names.load(".")
raw = [("/lp/Q4", 700, 6), ("/lp/q4", 18, 0), ("/lp/q4/", 2, 0), ("/lp/never-named", 50, 1)]
print(json.dumps(g.page_rows(names, lp_names.merge(names, raw), 8)))`);
    expect(rows).toEqual([
      { name: NAMES["/lp/Q4"].name, path: "/lp/Q4", sessions: 720, conv_pct: 0.83, alert: true },
      { name: "/lp/never-named", path: "/lp/never-named", sessions: 50, conv_pct: 2.0 },
    ]);
  });

  test("the landing-page table shows the name first and the path under it", async () => {
    const p = await page(
      snapshotWith((s) => {
        s.default_period = s.periods[0].id;
        s.periods[0].landing_pages = [
          { name: "Light checkout", path: "/lp/Q4", sessions: 720, conv_pct: 0.83, alert: true },
          { name: "/lp/never-named", path: "/lp/never-named", sessions: 50, conv_pct: 2.0 },
        ];
      }),
    );
    const rows = [...p.el("lp-panel").querySelectorAll(".lp-row")];
    expect(rows.map((r: any) => [r.querySelector(".lp-name").textContent, r.querySelector(".lp-path").textContent])).toEqual([
      ["Light checkout", "/lp/Q4"],
      ["/lp/never-named", "/lp/never-named"],
    ]);
  });

  test("the names file parses, every entry has a name, and no path is in it twice", () => {
    const keys = Object.keys(NAMES);
    for (const path of keys) {
      expect(path.startsWith("/"), path).toBe(true);
      expect(typeof NAMES[path].name, path).toBe("string");
      expect(NAMES[path].name.trim().length, path).toBeGreaterThan(0);
    }
    expect(new Set(keys.map((k) => k.toLowerCase())).size).toBe(keys.length);
  });

  test("all 29 names from the old inline dict and the 12 new ones are there, word for word", () => {
    expect(MIGRATED).toHaveLength(29);
    expect(ADDED).toHaveLength(12);
    for (const [path, name] of [...MIGRATED, ...ADDED]) expect(NAMES[path]?.name, path).toBe(name);
  });
});

describe("scripts/buy_path.py's sums", () => {
  const block = py(`
import buy_path, lp_names
from decimal import Decimal as D
names = lp_names.load(".")
orders = [("2026-10-08", "dark_cart", D("100.00")), ("2026-10-09", "dark_cart", D("50.50")),
          ("2026-10-06", "dark_cart", D("999")), ("2026-10-08", "campaign_us_gift", D("40")),
          ("2026-10-08", "light_cart", D("80"))]
ga = lp_names.merge(names, [("/lp/v3", 200, 2), ("/lp/V3", 100, 0), ("/lp/q4v2", 0, 0), ("/lp/v2", 10, 0)])
print(json.dumps(buy_path.window_block(names, "2026-10-07", "2026-10-18", orders, ga)))`);

  test("the four arms come in pair order, named from the file, case variants summed", () => {
    expect(block.arms.map((a: any) => [a.arm, a.name, a.path])).toEqual([
      ["dark_checkout", "Dark checkout", "/lp/v2"],
      ["dark_cart", "Dark cart", "/lp/v3"],
      ["light_checkout", "Light checkout", "/lp/Q4"],
      ["light_cart", "Light cart", "/lp/Q4v2"],
    ]);
    const cart = block.arms[1];
    expect([cart.sessions, cart.ga_purchases, cart.orders, cart.revenue_eur]).toEqual([300, 2, 2, 150.5]);
    expect([cart.conv_pct, cart.eur_per_100]).toEqual([0.67, 50.17]);
  });

  test("no sessions gives null rates, never zero, and an order outside the window is not counted", () => {
    const light = block.arms[3];
    expect([light.sessions, light.orders, light.conv_pct, light.eur_per_100]).toEqual([0, 1, null, null]);
    expect(block.arms[2].conv_pct).toBeNull();
    expect(block.campaign).toEqual([{ arm: "campaign_us_gift", orders: 1, revenue_eur: 40 }]);
  });
});

// A stand-in for `gate ga report`, so ga_rows runs its real parsing on hand-made rows.
const GA_FAKE = `
import subprocess
calls = []
def fake_ga(payload, code=0):
    def run(cmd, **kw):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, code, json.dumps(payload), "GA refused")
    subprocess.run = run
def report(rows, row_count="all"):
    data = {"rows": [{"dimensionValues": [{"value": p}], "metricValues": [{"value": str(s)}, {"value": str(b)}]}
                     for p, s, b in rows]}
    if row_count == "all": data["rowCount"] = len(rows)
    elif row_count is not None: data["rowCount"] = row_count
    return {"ok": True, "data": data}
`;

describe("reading GA4", () => {
  test("every row is read before the merge, so a small twin past row 32 is still summed", () => {
    const out = py(GA_FAKE + `
import ga_landing_pages as g, lp_names
names = lp_names.load(".")
rows = [("/lp/Q4", 723, 6)] + [(f"/p{i}", 500 - i, 0) for i in range(38)] + [("/lp/q4", 18, 0)]
fake_ga(report(rows))
top = g.page_rows(names, lp_names.merge(names, g.ga_rows("1", "2026-09-19", "2026-10-18")), 8)[0]
print(json.dumps({"top": top, "limit": calls[0][calls[0].index("--limit") + 1]}))`);
    expect(out.limit).toBe("2000");
    expect(out.top).toEqual({ name: "Light checkout", path: "/lp/Q4", sessions: 741, conv_pct: 0.81, alert: true });
  });

  test("a report with rows but no rowCount, or more pages than were read, is refused", () => {
    const out = py(GA_FAKE + `
import ga_landing_pages as g
said = []
for payload in (report([("/lp/v2", 1, 0)], None), report([("/lp/v2", 1, 0)], 2001)):
    fake_ga(payload)
    try:
        g.ga_rows("1", "2026-10-07", "2026-10-18")
        said.append("read")
    except SystemExit as e:
        said.append(str(e))
fake_ga(report([], None))
said.append(g.ga_rows("1", "2026-10-07", "2026-10-18"))
print(json.dumps(said))`);
    expect(out[0]).toContain("no rowCount");
    expect(out[1]).toContain("2001 landing pages");
    expect(out[2]).toEqual([]);
  });

  test("an arm the names file has lost still gets its visits, under GA's busiest spelling", () => {
    const light = py(`
import buy_path, lp_names
names = lp_names.load(".")
del names[lp_names.key_of("/lp/Q4v2")]
ga = lp_names.merge(names, [("/lp/q4v2", 30, 1), ("/lp/Q4V2", 5, 0)])
print(json.dumps(buy_path.window_block(names, "2026-10-07", "2026-10-18", [], ga)["arms"][3]))`);
    expect([light.arm, light.path, light.sessions, light.ga_purchases]).toEqual(["light_cart", "/lp/Q4v2", 35, 1]);
  });
});

// Shopify's orders query answered from hand-made pages; the cursor each call sent is kept.
const SHOPIFY_FAKE = `
import buy_path, io, urllib.request
from datetime import date
sent = []
def order(created, arms=("dark_cart",), amount="10.00", cur="EUR", test=False, cancelled=None):
    return {"createdAt": created, "cancelledAt": cancelled, "test": test,
            "customAttributes": [{"key": "lp_arm", "value": a} for a in arms],
            "currentTotalPriceSet": {"shopMoney": {"amount": amount, "currencyCode": cur}}}
def page(nodes, cursor=None):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor}}
def run(pages):
    def answer(req, timeout=None):
        sent.append(json.loads(req.data)["variables"]["after"])
        return io.BytesIO(json.dumps({"data": {"orders": pages[len(sent) - 1]}}).encode())
    urllib.request.urlopen = answer
    buy_path.time.sleep = lambda s: None
    try:
        got = buy_path.tagged_orders("token", date(2026, 10, 7), date(2026, 10, 18))
        return {"orders": [[d, a, str(e)] for d, a, e in got], "sent": sent}
    except SystemExit as e:
        return {"refused": str(e)}
`;

describe("scripts/buy_path.py's Shopify read", () => {
  test("both pages are read, test, cancelled and untagged orders left out, days counted in Stockholm", () => {
    const out = py(SHOPIFY_FAKE + `
print(json.dumps(run([
    page([order("2026-10-06T21:30:00Z"),                      # 23:30 on 6 Oct in Stockholm: before the test
          order("2026-10-06T22:30:00Z", amount="12.50"),      # 00:30 on 7 Oct: the first counted minute
          order("2026-10-08T10:00:00Z", test=True),
          order("2026-10-08T10:00:00Z", cancelled="2026-10-08T12:00:00Z"),
          order("2026-10-09T10:00:00Z", arms=())], "cursor-1"),
    page([order("2026-10-18T21:59:00Z", arms=("light_cart",)),  # 23:59 on 18 Oct
          order("2026-10-18T22:00:00Z")]),                       # midnight, 19 Oct: after the window
])))`);
    expect(out.sent).toEqual([null, "cursor-1"]);
    expect(out.orders).toEqual([
      ["2026-10-07", "dark_cart", "12.50"],
      ["2026-10-18", "light_cart", "10.00"],
    ]);
  });

  test("an order with two different tags, or not in EUR, stops the read", () => {
    const twoTags = py(SHOPIFY_FAKE + `print(json.dumps(run([page([order("2026-10-08T10:00:00Z", arms=("dark_cart", "light_cart"))])])))`);
    expect(twoTags.refused).toContain("two lp_arm values");
    const sek = py(SHOPIFY_FAKE + `print(json.dumps(run([page([order("2026-10-08T10:00:00Z", cur="SEK")])])))`);
    expect(sek.refused).toContain("is in SEK");
  });
});

describe("a failed pull writes nothing", () => {
  test("GA4 refusing leaves data/snapshot.json byte for byte as it was, and no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "buy-path-"));
    mkdirSync(join(dir, "data"));
    const before = JSON.stringify({ sources: { buy_path: { as_of: "2026-10-01", pulled: "2026-10-02" } }, buy_path: { old: true } });
    writeFileSync(join(dir, "data", "snapshot.json"), before);
    writeFileSync(join(dir, "data", "landing-page-names.json"), JSON.stringify(NAMES));
    const out = py(GA_FAKE + SHOPIFY_FAKE + `
fake_ga({}, code=1)
buy_path.shopify_token = lambda: "token"
urllib.request.urlopen = lambda req, timeout=None: io.BytesIO(json.dumps({"data": {"orders": page([])}}).encode())
sys.argv = ["buy_path.py", "--repo", ${JSON.stringify(dir)}, "--today", "2026-10-19"]
try:
    buy_path.main()
    print(json.dumps("wrote"))
except SystemExit as e:
    print(json.dumps(str(e)))`);
    expect(out).toContain("gate ga report failed");
    expect(readFileSync(join(dir, "data", "snapshot.json"), "utf8")).toBe(before);
    expect(readdirSync(join(dir, "data")).sort()).toEqual(["landing-page-names.json", "snapshot.json"]);
  });
});
