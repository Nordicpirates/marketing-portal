// Landing pages by name, and the buy-path test's two pairs on Marketing HQ. The Python half
// runs on hand-made rows, never on real pulls; the page half through tests/portal-harness.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { loadPortalPage, snapshotWith } from "./portal-harness.ts";

const REPO = join(import.meta.dir, "..");
const NAMES = JSON.parse(readFileSync(join(REPO, "data", "landing-page-names.json"), "utf8"));
const EXPERIMENTS = JSON.parse(readFileSync(join(REPO, "data", "experiments.json"), "utf8"));
const TASKS = JSON.parse(readFileSync(join(REPO, "data", "tasks.json"), "utf8"));

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
    expect(keys.length).toBeGreaterThan(30);
    for (const path of keys) {
      expect(path.startsWith("/"), path).toBe(true);
      expect(typeof NAMES[path].name, path).toBe("string");
      expect(NAMES[path].name.trim().length, path).toBeGreaterThan(0);
    }
    expect(new Set(keys.map((k) => k.toLowerCase())).size).toBe(keys.length);
    for (const [path, name] of [
      ["/lp/v2", "Dark checkout"], ["/lp/v3", "Dark cart"], ["/lp/Q4", "Light checkout"], ["/lp/Q4v2", "Light cart"],
      ["/lp/dark", "Dark split entry"], ["/lp/light", "Light split entry"], ["/lp/offer", "Campaign (all markets)"],
      ["/lp/offer-us", "Campaign US"], ["/lp/offer-eu", "Campaign EU"], ["/lp/offer-uk", "Campaign UK"],
      ["/lp/offer-au", "Campaign AU"], ["/lp/lying-pirates-cities-of-greed-big-box-c", "Big Box C (old dark)"],
      ["/", "Homepage"], ["/gift-offer", "Gift offer (LP)"],
    ]) expect(NAMES[path]?.name, path).toBe(name);
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
