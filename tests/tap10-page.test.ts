// The /tap10 page fed the builder's own output on the fixtures, and the TAP 10 tab on every
// portal page. Loading is tests/portal-harness.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { freshness, loadPortalPage, pageHtml } from "./portal-harness.ts";
import { FULL_ARGS, build } from "./tap10-fixture.ts";

const F = freshness();
const BUILT = build(FULL_ARGS);
if (BUILT.code !== 0) throw new Error(`the builder refused the fixtures: ${BUILT.stderr}`);
const DATA = BUILT.out;

const tap10 = (data: any = DATA) => loadPortalPage("tap10.html", { "/api/tap10": data });
const copy = (mutate: (d: any) => void) => {
  const d = JSON.parse(JSON.stringify(DATA));
  mutate(d);
  return d;
};
const COLUMNS = ["Dag", "Anmälningar", "Väntelista totalt", "KS-följare", "Kickstarter-sidvisningar (Meta-pixel)",
  "Kickstarter-besök (GA)", "GA-besök", "Annonsklick", "Annonskostnad SEK", "Kr/anmälan", "Film start/klar",
  "Reels start/klar", "Demo start/klar", '"Try the demo"-klick', "Snittid per besök"];
const col = (name: string) => COLUMNS.indexOf(name);

async function kpis(page: any): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const card of page.el("kpi-grid").querySelectorAll(".kpi")) {
    out[card.querySelector(".k").textContent] = card.querySelector(".n").textContent.replace(/\s/g, " ");
  }
  return out;
}

describe("the TAP 10 page", () => {
  test("renders with no console errors", async () => {
    const page = await tap10();
    expect(page.errors).toEqual([]);
  });

  test("every freshness slot is filled, each from its own source", async () => {
    const page = await tap10();
    const ids = page.freshnessIds();
    expect(ids).toEqual(["fr-kpis", "fr-chart", "fr-days", "fr-videos", "fr-forms", "fr-ga-sources"]);
    for (const id of ids) expect(page.html(id), `#${id} has no pill`).toContain("fr-");
    expect(page.text("fr-videos")).toContain(F.short(DATA.sources.ga.as_of));
    expect(page.text("fr-forms")).toContain("Signups (Brevo)");
  });

  test("the table has every column the brief asks for, newest day first", async () => {
    const page = await tap10();
    const heads = [...page.document.querySelectorAll("thead")][0].querySelectorAll("th");
    expect([...heads].map((th: any) => th.textContent)).toEqual(COLUMNS);
    expect(page.rows("days-body").map((r) => r[0].slice(0, 10))).toEqual(["2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06"]);
  });

  test("a null field shows a dash, never a 0", async () => {
    const page = await tap10();
    const [today, , d7] = page.rows("days-body");
    expect(DATA.days[0].ga_sessions).toBeNull();
    expect(today[col("GA-besök")]).toBe("-");
    expect(today[col("Kickstarter-besök (GA)")]).toBe("-");
    expect(today[col("Annonskostnad SEK")]).toBe("-");
    expect(today[col("Demo start/klar")]).toBe("-");
    expect(today[col("Snittid per besök")]).toBe("-");
    // A real zero stays a zero.
    expect(d7[col("Film start/klar")]).toBe("0 / 0");
    expect(page.rows("days-body")[1][col("Anmälningar")]).toBe("0");
  });

  test("today says it is still running, GA's last day says it is provisional", async () => {
    const page = await tap10();
    expect(page.rows("days-body")[0][0]).toContain("pågår");
    expect(page.rows("days-body")[1][0]).toContain("GA preliminär");
  });

  test("Kickstarter visits from GA and the pixel's page views sit side by side, apart from tap10game.com", async () => {
    const page = await tap10();
    const d6 = page.rows("days-body")[3];
    expect(d6[col("Kickstarter-sidvisningar (Meta-pixel)")]).toBe("4");
    expect(d6[col("Kickstarter-besök (GA)")]).toBe("500");
    expect(d6[col("GA-besök")]).toBe("40");
  });

  test("since launch sums the whole days only, and levels show their last reading", async () => {
    const page = await tap10();
    expect(page.text("range-caption")).toContain("2026-10-06 till 2026-10-08");
    const k = await kpis(page);
    expect(k["Anmälningar"]).toBe("3");
    expect(k["Väntelistan totalt"]).toBe("3");
    expect(k["Kickstarter-följare"]).toBe("194");
    expect(k["Kickstarter-sidvisningar (Meta-pixel)"]).toBe("9");
    expect(k["Kickstarter-besök (GA)"]).toBe("507");
    expect(k["Besökare tap10game.com"]).toBe("60");
    expect(k["Annonskostnad"]).toBe("351 kr");
    expect(k["Kostnad per anmälan"]).toBe("117 kr");
    expect(k["Filmstarter"]).toBe("13");
    expect(k["Demospel"]).toBe("5");
  });

  test("Igår is one day, with the change against the day before", async () => {
    const page = await tap10();
    page.document.querySelector('.preset[data-w="yday"]').click();
    expect(page.text("range-caption")).toContain("2026-10-08 till 2026-10-08");
    const k = await kpis(page);
    expect(k["Anmälningar"]).toBe("0");
    expect(k["Kickstarter-besök (GA)"]).toBe("7");
    expect(k["Kostnad per anmälan"]).toBe("-");
    expect(page.text("kpi-grid")).toContain("+0 i perioden");
  });

  test("videos, signup sources and GA sources are drawn from the data", async () => {
    const page = await tap10();
    expect(page.rows("videos-body")).toEqual([["TAP 10 film", "7", "3"], ["Reel Ana", "4", "1"], ["Reel Bo", "2", "0"]]);
    expect(page.rows("forms-body")).toEqual([["bar", "1"], ["hero", "1"], ["join", "1"], ["offer", "1"]]);
    expect(page.rows("media-body")).toEqual([["paid_social", "2"], ["-", "1"], ["email", "1"]]);
    expect(page.rows("sources-body")).toEqual([["facebook", "paid", "25"], ["google", "organic", "15"]]);
  });

  test("the chart has signups and followers, oldest day first", async () => {
    const page = await tap10();
    expect(page.charts).toHaveLength(1);
    const sets = page.charts[0].config.data.datasets;
    expect(sets.map((s: any) => s.label)).toEqual(["Anmälningar per dag", "Kickstarter-följare"]);
    expect(sets[0].data).toEqual([1, 2, 0, 1]);
    expect(sets[1].data).toEqual([157, 194, null, 213]);
  });

  test("a missing source says unavailable in its pill and its numbers are dashes", async () => {
    const data = copy((d) => {
      d.sources.ads = { as_of: null, text: "unavailable", note: "no Meta ads file was given" };
      for (const row of d.days) row.ad_spend_sek = row.ad_clicks = null;
    });
    const page = await tap10(data);
    expect(page.text("fr-kpis")).toContain("Meta ads unavailable");
    expect(page.text("fr-kpis")).toContain("no Meta ads file was given");
    const k = await kpis(page);
    expect(k["Annonskostnad"]).toBe("-");
    expect(k["Kostnad per anmälan"]).toBe("-");
    expect(page.errors).toEqual([]);
  });

  test("before the first build the page says so, with every pill and no errors", async () => {
    const page = await tap10({ days: [] });
    expect(page.errors).toEqual([]);
    expect(page.text("days-body")).toContain("Inga dagar byggda än");
    expect(page.text("range-caption")).toContain("inga dagar byggda än");
    for (const id of page.freshnessIds()) expect(page.html(id)).toContain("fr-unknown");
    expect(page.charts).toHaveLength(0);
    expect(Object.values(await kpis(page)).every((v) => v === "-")).toBe(true);
  });

  test("a title with markup in it is shown, not run", async () => {
    const page = await tap10(copy((d) => (d.videos = [{ title: "<img src=x onerror=alert(1)>", starts: 1, completes: 0 }])));
    expect(page.rows("videos-body")[0][0]).toBe("<img src=x onerror=alert(1)>");
    expect(page.el("videos-body").querySelectorAll("img")).toHaveLength(0);
  });

  test("no em or en dash anywhere a reader can see", async () => {
    const page = await tap10();
    expect(page.document.body.textContent).not.toMatch(/[–—]/);
    expect(pageHtml("tap10.html")).not.toMatch(/[–—]/);
  });
});

describe("the TAP 10 tab", () => {
  const portalPages = readdirSync(join(import.meta.dir, "..", "public"))
    .filter((f) => f.endsWith(".html") && !f.startsWith("lp-"));

  test("is on every portal page, next to Assets, and active only on its own", () => {
    expect(portalPages.sort()).toEqual(
      ["assets", "dashboard", "growth", "ideas", "index", "inventory", "qr", "shipments", "tap10"].map((p) => `${p}.html`),
    );
    for (const file of portalPages) {
      const html = pageHtml(file);
      expect(html, `${file} has no TAP 10 tab`).toMatch(/<a href="\/tap10"( class="active")?>TAP 10<\/a>/);
      expect(html, `${file} has no Assets tab`).toContain('href="/assets"');
      expect(html.includes('<a href="/tap10" class="active">'), file).toBe(file === "tap10.html");
    }
  });
});
