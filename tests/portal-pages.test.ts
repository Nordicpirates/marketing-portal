// The Dashboard and the Lager page: every section dated from ITS OWN source, never from
// the page's snapshot date. Loading is tests/portal-harness.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { SNAPSHOT, freshness, loadPortalPage, snapshotWith } from "./portal-harness.ts";

const F = freshness();
const TASKS = JSON.parse(readFileSync(join(import.meta.dir, "..", "data", "tasks.json"), "utf8"));

const dashboard = (snapshot: any = SNAPSHOT) => loadPortalPage("dashboard.html", { "/api/data": snapshot });
const inventory = (snapshot: any = SNAPSHOT) => loadPortalPage("inventory.html", { "/api/data": snapshot });

describe("dashboard", () => {
  test("renders with no console errors", async () => {
    const page = await dashboard();
    expect(page.errors).toEqual([]);
  });

  test("every freshness slot is filled", async () => {
    const page = await dashboard();
    const ids = page.freshnessIds();
    expect(ids).toContain("fr-yest");
    expect(ids).toContain("fr-channels");
    for (const id of ids) expect(page.html(id), `#${id} has no pill`).toContain("fr-");
  });

  test("the two trend charts are dated separately, because their data is", async () => {
    // The revenue chart is re-pulled daily and the sessions chart is not. Before this
    // they sat side by side with one page date over both.
    const page = await dashboard();
    expect(page.text("fr-orders-chart")).toContain(F.short(SNAPSHOT.sources.shopify.as_of));
    expect(page.text("fr-sessions-chart")).toContain(F.short(SNAPSHOT.sources.sessions_chart.as_of));
    expect(page.text("fr-orders-chart")).not.toBe(page.text("fr-sessions-chart"));
  });

  test("a stale section is called out in red with its age, not left looking current", async () => {
    const page = await dashboard(
      snapshotWith((s) => {
        s.sources.channels = { as_of: "2026-01-05", pulled: "2026-01-05", note: "the old channel pull" };
      }),
    );
    expect(page.html("fr-channels")).toContain("fr-stale");
    expect(page.text("fr-channels")).toContain("5 Jan");
    expect(page.text("fr-channels")).toContain("the old channel pull");
  });

  test("the hand-kept status list says it is kept by hand rather than showing a date", async () => {
    const page = await dashboard();
    expect(page.text("fr-status")).toContain("Action list");
    expect(page.text("fr-status")).toContain("kept by hand");
  });

  test("no section borrows the snapshot's own date", async () => {
    const page = await dashboard(
      snapshotWith((s) => {
        s.generated_at = "2026-09-26";
        s.sources.channels.as_of = "2026-02-03";
        s.sources.sessions_chart.as_of = "2026-02-04";
      }),
    );
    for (const id of ["fr-channels", "fr-sessions-chart"]) {
      expect(page.text(id)).not.toContain("26 Sep");
    }
  });
});

describe("lager", () => {
  test("renders with no console errors", async () => {
    const page = await inventory();
    expect(page.errors).toEqual([]);
  });

  test("the stock figures carry the stock pull's date, not the snapshot's", async () => {
    const page = await inventory();
    expect(page.text("fr-inventory")).toContain(F.short(SNAPSHOT.sources.inventory.as_of));
    expect(page.text("updBadge")).toContain(SNAPSHOT.inventory_data.updated_at);
  });

  test("stock older than a week is called out, not shown as a quiet grey badge", async () => {
    const page = await inventory(
      snapshotWith((s) => {
        s.sources.inventory = { as_of: "2026-06-01", pulled: "2026-06-01" };
        s.inventory_data.updated_at = "2026-06-01";
      }),
    );
    expect(page.html("fr-inventory")).toContain("fr-stale");
    expect(page.text("fr-inventory")).toMatch(/\d+d old/);
  });

  test("a real variant is never collapsed away, in the alerts or in the table", async () => {
    const page = await inventory();
    const named = SNAPSHOT.inventory_data.products.filter((p: any) => p.variant && p.variant !== "Default");
    expect(named.length).toBeGreaterThan(0);

    const table = page.text("prodRows");
    for (const p of named) expect(table).toContain(p.variant);

    // Two rows of the same product must stay distinguishable in the alert cards.
    const alerting = named.filter((p: any) => ["oversold", "critical", "low"].includes(p.status));
    const alerts = page.text("alertGrid");
    for (const p of alerting) expect(alerts).toContain(`${p.title} · ${p.variant}`);
  });

  test("the Default placeholder is not printed as if it were a variant", async () => {
    const page = await inventory();
    expect(SNAPSHOT.inventory_data.products.some((p: any) => p.variant === "Default")).toBe(true);
    expect(page.text("prodRows")).not.toContain("Default");
    expect(page.text("alertGrid")).not.toContain("· Default");
  });

  test("two variants of one product are two separate alert cards", async () => {
    const page = await inventory(
      snapshotWith((s) => {
        for (const p of s.inventory_data.products) {
          if (p.title === "BIG BOX" && (p.variant === "Italian" || p.variant === "English")) p.status = "critical";
        }
      }),
    );
    const alerts = page.text("alertGrid");
    expect(alerts).toContain("BIG BOX · Italian");
    expect(alerts).toContain("BIG BOX · English");
  });

  test("no inventory block at all says so and still dates the page", async () => {
    const page = await inventory(snapshotWith((s) => delete s.inventory_data));
    expect(page.text("prodRows")).toContain("Inventory data saknas");
    expect(page.text("updBadge")).toContain("ingen data");
    expect(page.html("fr-inventory")).toContain("fr-");
    expect(page.errors).toEqual([]);
  });
});

describe("serving", () => {
  test("markup and the shared script are both no-cache, so they cannot drift apart", () => {
    const server = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    // One helper for every page, so a cache header can never be set on six of seven.
    expect(server).toContain('function htmlPage(file: string): Response | null');
    expect(server).toContain('"Cache-Control": NO_CACHE');
    for (const page of ["index.html", "dashboard.html", "inventory.html", "growth.html", "ideas.html", "assets.html", "shipments.html"]) {
      expect(server, `${page} is not served through htmlPage`).toContain(`htmlPage("${page}")`);
    }
    // Only two places answer with HTML at all, htmlPage and the login form, and both
    // must carry the cache directive. A third would be a route with its own headers.
    const htmlHeaders = [...server.matchAll(/"Content-Type": "text\/html; charset=utf-8"([^\n]*)/g)];
    expect(htmlHeaders).toHaveLength(2);
    for (const [, rest] of htmlHeaders) expect(rest).toContain("NO_CACHE");
    expect(server).toContain('"Cache-Control": NO_CACHE');
  });

  test("markup older than the script says so instead of quietly losing every date", async () => {
    // A page cached from before the pills existed has none of the containers. The old
    // behaviour was to drop every date without a word.
    const html = readFileSync(join(import.meta.dir, "..", "public", "dashboard.html"), "utf8");
    expect(html).toContain("this markup is older than freshness.js");
    const index = readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf8");
    expect(index).toContain("this markup is older than freshness.js");
  });
});
