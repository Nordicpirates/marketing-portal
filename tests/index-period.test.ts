// The Marketing HQ page through its period toggle. Loading is tests/portal-harness.ts.
// Every expectation is DERIVED from data/snapshot.json: a typed date goes red on a refresh.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { SNAPSHOT, freshness, loadPortalPage, snapshotWith, type PortalPage } from "./portal-harness.ts";

const REPO = join(import.meta.dir, "..");
const HTML = readFileSync(join(REPO, "public", "index.html"), "utf8");
const EXPERIMENTS = JSON.parse(readFileSync(join(REPO, "data", "experiments.json"), "utf8"));
const TASKS = JSON.parse(readFileSync(join(REPO, "data", "tasks.json"), "utf8"));

type Page = PortalPage & {
  /** Click a period button by its visible label, and let the page re-render. */
  pick: (label: string) => void;
  presets: () => string[];
};

/** Load the page with the snapshot a test wants /api/data to answer. */
async function loadPage(snapshot: any = SNAPSHOT): Promise<Page> {
  const page = await loadPortalPage("index.html", {
    "/api/data": snapshot,
    "/api/experiments": EXPERIMENTS,
    "/api/tasks": TASKS,
  });
  const { document, window } = page;
  return {
    ...page,
    presets: () => [...document.querySelectorAll(".preset")].map((b: any) => b.textContent),
    pick(label: string) {
      const button = [...document.querySelectorAll(".preset")].find((b: any) => b.textContent === label);
      if (!button) throw new Error(`no period button labelled "${label}"`);
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    },
  };
}

/** A copy of the snapshot, so a test can take a key away without spoiling the next one. */
const snapshotWithout = snapshotWith;

const PERIOD_LABELS = SNAPSHOT.periods.map((p: any) => p.label);
const PERIODS = SNAPSHOT.periods as any[];

/** The shared module's own day formatter, so the test does not re-implement it. */
const F_SHORT = freshness().short as (iso: string) => string;

/** The single-day period, whichever one it is today. */
const ONE_DAY = PERIODS.find((p) => p.days === 1);

describe("period toggle", () => {
  test("offers every period in the snapshot, in snapshot order", async () => {
    const page = await loadPage();
    expect(page.presets()).toEqual(PERIOD_LABELS);
  });

  test("the one-day period is offered last, after the long windows", async () => {
    expect(ONE_DAY).toBeDefined();
    const page = await loadPage();
    const presets = page.presets();
    expect(presets).toHaveLength(PERIODS.length);
    expect(presets[presets.length - 1]).toBe(ONE_DAY.label);
    expect(PERIODS[PERIODS.length - 2].days).toBeGreaterThan(1);
  });

  test("no period label is written into the page, they all come from the data", async () => {
    for (const label of PERIOD_LABELS) expect(HTML).not.toContain(label);
  });

  test("a one-day period is not captioned '1 days'", async () => {
    const page = await loadPage();
    page.pick(ONE_DAY.label);
    expect(page.text("range-caption")).toContain("1 day");
    expect(page.text("range-caption")).not.toContain("1 days");
  });
});

/** ROAS the way the page prints it: Swedish decimal comma, trailing multiplication sign. */
function roasText(v: any): string {
  return v === null || v === undefined ? "—" : String(v).replace(".", ",") + "×";
}

/** Whitespace-normalised the same way Page.text() reads the DOM, so a stray space in the data is not a failure. */
function asRendered(v: any): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

describe("Google Ads follows the period", () => {
  test("Meta and Google both move when the period changes", async () => {
    // Two different windows, whichever two the snapshot carries, so this stays a test
    // of "the numbers follow the toggle" and not a copy of today's figures.
    const [first, second] = PERIODS;
    expect(first.meta.spend_label).not.toBe(second.meta.spend_label);
    const page = await loadPage();

    page.pick(first.label);
    expect(page.text("meta-grid")).toContain(first.meta.spend_label);
    expect(page.text("pgads-grid")).toContain(first.gads.spend_label);
    expect(page.text("pgads-grid")).toContain(roasText(first.gads.gads_roas));

    page.pick(second.label);
    expect(page.text("meta-grid")).toContain(second.meta.spend_label);
    expect(page.text("pgads-grid")).toContain(second.gads.spend_label);
    expect(page.text("pgads-grid")).toContain(roasText(second.gads.gads_roas));
  });

  test("every period shows its own Google numbers", async () => {
    const page = await loadPage();
    for (const period of SNAPSHOT.periods) {
      page.pick(period.label);
      const grid = page.text("pgads-grid");
      expect(grid).toContain(period.gads.spend_label);
      expect(grid).toContain(period.gads.value_label);
      expect(page.text("pgads-note")).toBe(asRendered(period.gads._note));
      expect(page.text("pgads-period")).toContain(period.label);
    }
  });

  test("the campaign table is the selected period's campaigns", async () => {
    const page = await loadPage();
    for (const period of PERIODS) {
      page.pick(period.label);
      const camps = period.gads.campaigns || [];
      expect(page.rows("pgads-body")).toEqual(
        camps.map((c: any) => [
          c.name,
          c.spend_label || "—",
          String(c.conv ?? 0),
          c.value_label || "—",
          roasText(c.roas),
        ]),
      );
    }
  });

  test("the one-day period renders the same sections as the long windows", async () => {
    const page = await loadPage();
    page.pick(ONE_DAY.label);

    expect(page.text("kpi-grid")).toContain(ONE_DAY.kpis.sales_label);
    expect(page.text("meta-grid")).toContain(ONE_DAY.meta.spend_label);
    expect(page.text("pgads-grid")).toContain(ONE_DAY.gads.spend_label);

    // Each of these is drawn only when the period actually carries its rows, so the
    // expectation is "shown exactly when there is something to show".
    const oc = ONE_DAY.orders_by_country || [];
    expect(page.shown("orders-country-section")).toBe(oc.length > 0);
    if (oc.length) {
      expect(page.rows("oc-body")[0]).toEqual([`${oc[0].flag} ${oc[0].name}`.trim(), String(oc[0].orders), oc[0].revenue]);
    }

    const lps = ONE_DAY.landing_pages || [];
    expect(page.shown("lp-section")).toBe(lps.length > 0);
    if (lps.length) expect(page.text("lp-panel")).toContain(lps[0].name);

    expect(page.shown("pgads-section")).toBe(true);
  });

  test("the since-start summary keeps its own numbers whatever the period", async () => {
    const page = await loadPage();
    for (const label of PERIOD_LABELS) {
      page.pick(label);
      expect(page.shown("gads-section")).toBe(true);
      expect(page.text("gads-grid")).toContain(SNAPSHOT.gads.spend_label);
      expect(page.rows("gads-body")).toHaveLength(SNAPSHOT.gads.campaigns.length);
    }
  });

  test("switching through every period logs nothing to console.error", async () => {
    const page = await loadPage();
    for (const label of PERIOD_LABELS) page.pick(label);
    expect(page.errors).toEqual([]);
  });
});

describe("snapshots without per-period Google data", () => {
  test("the Google period block is hidden, not left empty", async () => {
    const page = await loadPage(snapshotWithout((s) => s.periods.forEach((p: any) => delete p.gads)));
    for (const label of PERIOD_LABELS) {
      page.pick(label);
      expect(page.shown("pgads-section")).toBe(false);
    }
    expect(page.errors).toEqual([]);
  });

  test("the rest of the period, and the since-start summary, still render", async () => {
    const page = await loadPage(snapshotWithout((s) => s.periods.forEach((p: any) => delete p.gads)));
    page.pick(PERIODS[1].label);
    expect(page.shown("pgads-section")).toBe(false);
    expect(page.text("meta-grid")).toContain(PERIODS[1].meta.spend_label);
    expect(page.shown("gads-section")).toBe(true);
    expect(page.text("gads-grid")).toContain(SNAPSHOT.gads.spend_label);
  });

  test("one period missing gads does not hide it for the others", async () => {
    const page = await loadPage(snapshotWithout((s) => delete s.periods[1].gads));
    page.pick(PERIODS[1].label);
    expect(page.shown("pgads-section")).toBe(false);
    page.pick(PERIODS[0].label);
    expect(page.shown("pgads-section")).toBe(true);
    expect(page.text("pgads-grid")).toContain(PERIODS[0].gads.spend_label);
  });

  test("Google spend with no campaign breakdown drops the table, not the numbers", async () => {
    const page = await loadPage(snapshotWithout((s) => delete s.periods[0].gads.campaigns));
    page.pick(PERIODS[0].label);
    expect(page.shown("pgads-section")).toBe(true);
    expect(page.text("pgads-grid")).toContain(PERIODS[0].gads.spend_label);
    expect(page.shown("pgads-panel")).toBe(false);
    expect(page.errors).toEqual([]);
  });
});

describe("every section says how old its own numbers are", () => {
  test("each freshness slot on the page is filled, none is left blank", async () => {
    const page = await loadPage();
    const ids = page.freshnessIds();
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      expect(page.html(id), `#${id} has no freshness pill`).toContain("fr-");
    }
  });

  test("a section is never labelled with the page's own generated date", async () => {
    // The whole point of the issue: one global date reused everywhere let a 48-day-old
    // landing-page table look as current as this morning's Shopify pull.
    const stale = snapshotWithout((s) => {
      s.sources.landing_pages = { as_of: "2026-01-02", pulled: "2026-01-02", note: "frozen in January" };
    });
    const page = await loadPage(stale);
    page.pick(PERIODS[0].label);
    expect(page.text("fr-lp")).toContain("2 Jan");
    expect(page.text("fr-lp")).toContain("frozen in January");
    expect(page.html("fr-lp")).toContain("fr-stale");
    expect(page.text("fr-lp")).not.toContain(stale.generated_at);
  });

  test("a source with no date shows unknown, not a borrowed one", async () => {
    // Whichever source is dateless today. Naming one by hand goes red the day it gets
    // a real pull, which is the wrong reason for a test to fail.
    const dateless = Object.entries<any>(SNAPSHOT.sources).filter(([, v]) => v.as_of === null && !v.text);
    expect(dateless.length).toBeGreaterThan(0);
    const page = await loadPage();
    const stamped = page.freshnessIds().map((id) => page.text(id)).join(" | ");
    expect(stamped).toContain("as of unknown");
    for (const [key] of dateless) {
      const label = freshness().LABELS[key] || key;
      if (stamped.includes(label)) expect(stamped).toContain("as of unknown");
    }
  });

  test("a snapshot with no sources block at all shrugs rather than lying", async () => {
    const page = await loadPage(snapshotWithout((s) => delete s.sources));
    // fr-snapshot reads generated_at and fr-exp reads experiments.json, so neither is
    // affected by the snapshot losing its sources index.
    for (const id of page.freshnessIds()) {
      if (id === "fr-snapshot" || id === "fr-exp") continue;
      expect(page.html(id), `#${id}`).toContain("fr-unknown");
    }
    expect(page.errors).toEqual([]);
  });

  test("the experiments section is dated from its own file, not from the snapshot", async () => {
    const page = await loadPage();
    expect(page.text("fr-exp")).toContain("Experiments");
    expect(page.text("fr-exp")).toContain(F_SHORT(EXPERIMENTS.updated));
  });

  test("the header still carries the snapshot's own date, separate from the sections", async () => {
    const page = await loadPage();
    expect(page.text("snap-date")).toBe(SNAPSHOT.generated_at);
    expect(page.html("fr-snapshot")).toContain("fr-");
  });

  test("switching periods does not wipe the pills", async () => {
    const page = await loadPage();
    for (const label of PERIOD_LABELS) page.pick(label);
    expect(page.html("fr-store")).toContain("fr-");
    expect(page.html("fr-lp")).toContain("fr-");
    expect(page.errors).toEqual([]);
  });
});

describe("conversion, one card per denominator", () => {
  test("provisional orders per visit retains unknown sessions and does not claim converted sessions", async () => {
    const snapshot = snapshotWith((s) => {
      s.default_period = s.periods[0].id;
      s.periods[0].conversion = { provisional: true, orders: 15, sessions_ga4: 481,
        blended_pct: 3.12, note: 'Processing incomplete; not an exact session purchase rate.' };
      s.periods[0].kpis.conversion_label = '3.12% (provisional)';
    });
    const page = await loadPage(snapshot);
    expect(page.text('conv-grid')).toContain('15 Shopify orders / 481 GA4 sessions');
    expect(page.text('conv-grid')).toContain('including unknown landing pages');
    expect(page.text('conv-grid')).not.toContain('Real conversion');
    expect(page.text('conv-grid')).not.toContain('Target');
    expect(page.text('kpi-grid')).toContain('Provisional orders per measured visit');
    expect(page.text('conv-note')).toContain('not an exact session purchase rate');
    expect(page.errors).toEqual([]);
  });

  test("default selection and freshness follow the selected period", async () => {
    const page = await loadPage();
    const selected = PERIODS.find(p => p.id === SNAPSHOT.default_period);
    expect(page.text('range-caption')).toContain(selected.label);
    if (selected.sources?.sessions) {
      expect(page.text('fr-store')).toContain(F_SHORT(selected.sources.sessions.as_of));
      page.pick(PERIODS[0].label);
      expect(page.text('fr-store')).toContain(F_SHORT(SNAPSHOT.sources.sessions.as_of));
    }
  });
  test("all four rates are drawn, and each one names the traffic it was measured on", async () => {
    const page = await loadPage();
    page.pick(PERIODS[0].label);
    const c = PERIODS[0].conversion;
    const shown = page.text("conv-grid");
    for (const [label, value] of [
      ["Real conversion", c.blended_pct],
      ["Store traffic", c.store_pct],
      ["Landing pages", c.landing_pages_pct],
      ["Shopify reports", c.shopify_pct],
    ] as [string, number][]) {
      expect(shown, label).toContain(label);
      expect(shown, label).toContain(value.toFixed(2).replace(".", ","));
    }
    // The denominators are the whole argument, so each has to be on the card.
    expect(shown).toContain(String(c.sessions_ga4).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    expect(shown).toContain(String(c.sessions_shopify).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  });

  test("Shopify's own rate is marked as storefront only, never as the real one", async () => {
    const page = await loadPage();
    page.pick(PERIODS[0].label);
    expect(page.html("conv-grid")).toContain("conv reported");
    expect(page.text("conv-grid")).toContain("landing pages are not in the bottom of it");
    expect(page.html("conv-grid")).toContain("conv real");
  });

  test("the estimated split says it is estimated, in the cards and in the note", async () => {
    const page = await loadPage();
    page.pick(PERIODS[0].label);
    expect(PERIODS[0].conversion.split_is_estimated).toBe(true);
    expect((page.text("conv-grid").match(/Split estimated/g) || [])).toHaveLength(2);
    expect(page.text("conv-note")).toContain("a split rather than a measurement");
  });

  test("the target is read from the page, and the distance to it is worked out", async () => {
    const page = await loadPage();
    page.pick(PERIODS[0].label);
    const c = PERIODS[0].conversion;
    const factor = (3 / c.blended_pct).toFixed(1).replace(".", ",");
    expect(page.text("conv-grid")).toContain(`Target 3% is ${factor}x this`);
  });

  test("the rates follow the period, they are not one figure for the page", async () => {
    const page = await loadPage();
    const seen = new Set<string>();
    for (const period of PERIODS) {
      page.pick(period.label);
      expect(page.text("conv-grid")).toContain(period.conversion.blended_pct.toFixed(2).replace(".", ","));
      seen.add(page.text("conv-grid"));
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(page.errors).toEqual([]);
  });

  test("a snapshot with no conversion block says so instead of drawing nothing", async () => {
    const page = await loadPage(snapshotWithout((s) => s.periods.forEach((p: any) => delete p.conversion)));
    expect(page.text("conv-grid")).toBe("");
    expect(page.text("conv-note")).toContain("No conversion breakdown");
    expect(page.errors).toEqual([]);
  });
});
