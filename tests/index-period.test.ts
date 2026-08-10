// The real Marketing HQ page, loaded into a DOM and driven through its period toggle.
//
// Nothing here re-implements the page. Its script is inline, so it is lifted out of the
// HTML and evaluated against the DOM, fetch and console this file controls. The only
// rewrite is dropping the trailing load() call, so the test can await the first render
// instead of racing it. Both liftings fail loudly if the page stops looking that way.
//
// The data is the repo's own data/snapshot.json, so these tests read the same Google
// and Meta numbers a person looking at the deployed page reads.

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const HTML = readFileSync(join(REPO, "public", "index.html"), "utf8");
const SNAPSHOT = JSON.parse(readFileSync(join(REPO, "data", "snapshot.json"), "utf8"));
const EXPERIMENTS = JSON.parse(readFileSync(join(REPO, "data", "experiments.json"), "utf8"));
const TASKS = JSON.parse(readFileSync(join(REPO, "data", "tasks.json"), "utf8"));

/** The page's own script, ready to evaluate, with its self-start call removed. */
function pageScript(): string {
  const tag = HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!tag) throw new Error("public/index.html has no inline <script> any more, this harness is stale");
  const withStart = tag[1];
  const src = withStart.replace(/\nload\(\);\s*$/, "\n");
  if (src === withStart) throw new Error("the page no longer ends by calling load(), this harness is stale");
  return src;
}

type Page = {
  document: any;
  /** Everything the page sent to console.error. Expected to stay empty. */
  errors: string[];
  /** Click a period button by its visible label, and let the page re-render. */
  pick: (label: string) => void;
  presets: () => string[];
  text: (id: string) => string;
  shown: (id: string) => boolean;
  rows: (id: string) => string[][];
};

/** Load the page with the snapshot a test wants /api/data to answer. */
async function loadPage(snapshot: any = SNAPSHOT): Promise<Page> {
  const window = new Window({
    url: "https://marketing.nordicpirate.com/",
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
    },
  });
  const document = window.document;
  document.write(HTML);

  const errors: string[] = [];
  const answers: Record<string, any> = {
    "/api/data": snapshot,
    "/api/experiments": EXPERIMENTS,
    "/api/tasks": TASKS,
  };
  const fetchStub = async (path: string) => {
    if (!(path in answers)) throw new Error(`the page fetched ${path}, which this harness does not answer`);
    return new Response(JSON.stringify(answers[path]), { headers: { "Content-Type": "application/json" } });
  };
  const consoleStub = {
    ...console,
    error: (...args: any[]) => void errors.push(args.map(String).join(" ")),
  };

  const start = new Function(
    "window",
    "document",
    "fetch",
    "console",
    "navigator",
    pageScript() + "\nreturn load;",
  )(window, document, fetchStub, consoleStub, window.navigator);
  await start();

  const el = (id: string) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`no #${id} on the page`);
    return found;
  };

  return {
    document,
    errors,
    presets: () => [...document.querySelectorAll(".preset")].map((b: any) => b.textContent),
    pick(label: string) {
      const button = [...document.querySelectorAll(".preset")].find((b: any) => b.textContent === label);
      if (!button) throw new Error(`no period button labelled "${label}"`);
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    text: (id: string) => el(id).textContent.replace(/\s+/g, " ").trim(),
    shown: (id: string) => el(id).style.display !== "none",
    rows: (id: string) =>
      [...el(id).querySelectorAll("tr")].map((tr: any) =>
        [...tr.querySelectorAll("td")].map((td: any) => td.textContent.trim()),
      ),
  };
}

/** A copy of the snapshot, so a test can take a key away without spoiling the next one. */
function snapshotWithout(mutate: (copy: any) => void): any {
  const copy = JSON.parse(JSON.stringify(SNAPSHOT));
  mutate(copy);
  return copy;
}

const PERIOD_LABELS = SNAPSHOT.periods.map((p: any) => p.label);

describe("period toggle", () => {
  test("offers every period in the snapshot, in snapshot order", async () => {
    const page = await loadPage();
    expect(page.presets()).toEqual(PERIOD_LABELS);
  });

  test("Yesterday is the fifth option, after Last 90 days", async () => {
    const page = await loadPage();
    const presets = page.presets();
    expect(presets).toHaveLength(5);
    expect(presets[3]).toBe("Last 90 days");
    expect(presets[4]).toBe("Yesterday (Aug 9)");
  });

  test("the Yesterday label is read from the data, never written into the page", async () => {
    expect(HTML).not.toContain("Yesterday");
    expect(HTML).not.toContain("Aug 9");
  });

  test("a one-day period is not captioned '1 days'", async () => {
    const page = await loadPage();
    page.pick("Yesterday (Aug 9)");
    expect(page.text("range-caption")).toContain("1 day");
    expect(page.text("range-caption")).not.toContain("1 days");
  });
});

describe("Google Ads follows the period", () => {
  test("Meta and Google both move when the period changes", async () => {
    const page = await loadPage();

    page.pick("Last 7 days");
    expect(page.text("meta-grid")).toContain("18 913 kr");
    expect(page.text("pgads-grid")).toContain("4 929 kr");
    expect(page.text("pgads-grid")).toContain("1,89×");

    page.pick("Last 30 days");
    expect(page.text("meta-grid")).toContain("132 956 kr");
    expect(page.text("pgads-grid")).toContain("18 019 kr");
    expect(page.text("pgads-grid")).toContain("3,9×");
  });

  test("every period shows its own Google numbers", async () => {
    const page = await loadPage();
    for (const period of SNAPSHOT.periods) {
      page.pick(period.label);
      const grid = page.text("pgads-grid");
      expect(grid).toContain(period.gads.spend_label);
      expect(grid).toContain(period.gads.value_label);
      expect(page.text("pgads-note")).toBe(period.gads._note);
      expect(page.text("pgads-period")).toContain(period.label);
    }
  });

  test("the campaign table is the selected period's campaigns", async () => {
    const page = await loadPage();

    page.pick("Last 7 days");
    expect(page.rows("pgads-body")).toEqual([
      ["Shopping - US & UK", "3 152 kr", "4", "4 593 kr", "1,46×"],
      ["Shopping - AU", "726 kr", "1", "503 kr", "0,69×"],
      ["Brand Search - All Markets", "524 kr", "2", "3 762 kr", "7,18×"],
      ["Brand Search - IT", "362 kr", "2", "460 kr", "1,27×"],
      ["Non-brand Test - US & UK", "165 kr", "0", "0 kr", "0×"],
    ]);

    page.pick("Yesterday (Aug 9)");
    expect(page.rows("pgads-body")).toEqual([
      ["Shopping - US & UK", "469 kr", "1", "448 kr", "0,95×"],
      ["Shopping - AU", "82 kr", "0", "0 kr", "0×"],
      ["Brand Search - IT", "55 kr", "0", "0 kr", "0×"],
      ["Brand Search - All Markets", "38 kr", "0", "0 kr", "0×"],
    ]);
  });

  test("Yesterday renders the same sections as the other periods", async () => {
    const page = await loadPage();
    page.pick("Yesterday (Aug 9)");

    expect(page.text("kpi-grid")).toContain("€1,231");
    expect(page.text("meta-grid")).toContain("2 887 kr");
    expect(page.text("pgads-grid")).toContain("645 kr");
    expect(page.rows("oc-body")[0]).toEqual(["🇺🇸 USA", "5", "€411"]);
    expect(page.text("lp-panel")).toContain("Base Game (product)");
    for (const id of ["pgads-section", "lp-section", "orders-country-section"]) {
      expect(page.shown(id)).toBe(true);
    }
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
    page.pick("Last 30 days");
    expect(page.shown("pgads-section")).toBe(false);
    expect(page.text("meta-grid")).toContain("132 956 kr");
    expect(page.shown("gads-section")).toBe(true);
    expect(page.text("gads-grid")).toContain("18 339 kr");
  });

  test("one period missing gads does not hide it for the others", async () => {
    const page = await loadPage(snapshotWithout((s) => delete s.periods[1].gads));
    page.pick("Last 30 days");
    expect(page.shown("pgads-section")).toBe(false);
    page.pick("Last 7 days");
    expect(page.shown("pgads-section")).toBe(true);
    expect(page.text("pgads-grid")).toContain("4 929 kr");
  });

  test("Google spend with no campaign breakdown drops the table, not the numbers", async () => {
    const page = await loadPage(snapshotWithout((s) => delete s.periods[0].gads.campaigns));
    page.pick("Last 7 days");
    expect(page.shown("pgads-section")).toBe(true);
    expect(page.text("pgads-grid")).toContain("4 929 kr");
    expect(page.shown("pgads-panel")).toBe(false);
    expect(page.errors).toEqual([]);
  });
});
