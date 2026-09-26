// The shared freshness module on its own: the age rules every portal page draws through,
// tested once here rather than per page.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SRC = readFileSync(join(REPO, "public", "freshness.js"), "utf8");
const SNAPSHOT = JSON.parse(readFileSync(join(REPO, "data", "snapshot.json"), "utf8"));

/** The module evaluated against a bare window, the way a page loads it. */
function load(): any {
  const window: any = {};
  new Function("window", SRC)(window);
  if (!window.Freshness) throw new Error("public/freshness.js no longer defines window.Freshness");
  return window.Freshness;
}

const F = load();
const NOW = new Date("2026-09-26T09:00:00Z");

describe("age", () => {
  test("counts whole days from an ISO day to today", () => {
    expect(F.ageDays("2026-09-26", NOW)).toBe(0);
    expect(F.ageDays("2026-09-25", NOW)).toBe(1);
    expect(F.ageDays("2026-08-09", NOW)).toBe(48);
  });

  test("anything that is not an ISO day has no age, and is never guessed at", () => {
    for (const bad of [null, undefined, "", "25 September", "2026-09", "yesterday", 20260926]) {
      expect(F.ageDays(bad as any, NOW)).toBeNull();
    }
  });

  test("today and yesterday are fresh, a few days is aging, over a week is stale", () => {
    expect(F.state("2026-09-26", NOW)).toBe("fresh");
    expect(F.state("2026-09-24", NOW)).toBe("fresh");
    expect(F.state("2026-09-23", NOW)).toBe("aging");
    expect(F.state("2026-09-19", NOW)).toBe("aging");
    expect(F.state("2026-09-18", NOW)).toBe("stale");
    expect(F.state("2026-08-09", NOW)).toBe("stale");
  });

  test("a missing source is unknown, not fresh", () => {
    expect(F.state(undefined, NOW)).toBe("unknown");
    expect(F.state(null, NOW)).toBe("unknown");
  });
});

describe("pills", () => {
  test("a fresh source shows its date and nothing about age", () => {
    const html = F.pill("shopify", { as_of: "2026-09-25" }, NOW);
    expect(html).toContain("fr-fresh");
    expect(html).toContain("Shopify");
    expect(html).toContain("25 Sep");
    expect(html).not.toContain("old");
  });

  test("a stale source shows how many days old it is", () => {
    const html = F.pill("landing_pages", { as_of: "2026-08-09" }, NOW);
    expect(html).toContain("fr-stale");
    expect(html).toContain("9 Aug");
    expect(html).toContain("48d old");
  });

  test("a source with no date says so instead of showing a date", () => {
    const html = F.pill("sessions", { as_of: null }, NOW);
    expect(html).toContain("fr-unknown");
    expect(html).toContain("as of unknown");
    expect(html).not.toMatch(/\d/);
  });

  test("a hand-kept source can say what it is instead of 'unknown'", () => {
    const html = F.pill("tracking", { as_of: null, text: "kept by hand" }, NOW);
    expect(html).toContain("fr-unknown");
    expect(html).toContain("kept by hand");
  });

  test("a source name with no label of its own still renders, under its key", () => {
    expect(F.pill("brand_new_feed", { as_of: "2026-09-25" }, NOW)).toContain("brand_new_feed");
  });
});

describe("a section's row of pills", () => {
  test("one pill per source, in the order the section asked for", () => {
    const html = F.html(SNAPSHOT.sources, ["shopify", "amazon", "sessions"], NOW);
    expect(html.indexOf("Shopify")).toBeLessThan(html.indexOf("Amazon"));
    expect(html.indexOf("Amazon")).toBeLessThan(html.indexOf("Sessions"));
    expect(html.match(/class="fr /g) || []).toHaveLength(3);
  });

  test("the why line explains only what is stale or unknown", () => {
    const sources = {
      fine: { as_of: "2026-09-26", note: "should not be explained, it is current" },
      old: { as_of: "2026-01-01", note: "frozen since January" },
      none: { as_of: null, note: "no source at all" },
    };
    const html = F.html(sources, ["fine", "old", "none"], NOW);
    expect(html).toContain("frozen since January");
    expect(html).toContain("no source at all");
    expect(html).not.toContain("should not be explained");
  });

  test("no sources block at all renders unknown pills rather than throwing", () => {
    const html = F.html(undefined, ["shopify", "meta"], NOW);
    expect(html.match(/fr-unknown/g) || []).toHaveLength(2);
  });

  test("a note is escaped, never injected as markup", () => {
    const html = F.html({ x: { as_of: null, note: "<img src=x onerror=alert(1)>" } }, ["x"], NOW);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("the snapshot's own sources block", () => {
  test("every source the pages ask for exists and is shaped right", () => {
    const sources = SNAPSHOT.sources;
    expect(sources).toBeDefined();
    for (const [key, entry] of Object.entries<any>(sources)) {
      expect(typeof entry).toBe("object");
      expect("as_of" in entry).toBe(true);
      if (entry.as_of !== null) expect(F.ageDays(entry.as_of, NOW)).not.toBeNull();
      // A source with no date has to say why, or the page can only shrug at the reader.
      if (entry.as_of === null) expect(typeof entry.note).toBe("string");
    }
  });

  test("the sources index agrees with the dates the data already carried", () => {
    expect(SNAPSHOT.sources.inventory.as_of).toBe(SNAPSHOT.inventory_data.updated_at);
    expect(SNAPSHOT.sources.fx.as_of).toBe(SNAPSHOT.fx.date);
    expect(SNAPSHOT.sources.roas_series.as_of).toBe(SNAPSHOT.roas_series.as_of);
    expect(SNAPSHOT.sources.amazon.as_of).toBe(SNAPSHOT.amazon.as_of);
  });
});
