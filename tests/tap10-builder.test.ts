// scripts/tap10_snapshot.py run on hand-made fixtures in tests/fixtures/tap10, never on real pulls.
// What each number means: docs/TAP10.md

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FIX, FULL_ARGS, build } from "./tap10-fixture.ts";

const day = (out: any, d: string) => out.days.find((r: any) => r.date === d);

function tmpJson(dir: string, name: string, value: any): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

const gaReport = (rows: [string[], number[]][], rowCount = rows.length) => ({
  ok: true,
  data: {
    rowCount,
    rows: rows.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((v) => ({ value: String(v) })) })),
  },
});

describe("the full fixture", () => {
  const { code, out, stderr } = build(FULL_ARGS);

  test("it writes, one row per Stockholm day, newest first", () => {
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(out.days.map((d: any) => d.date)).toEqual(["2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06"]);
    expect(out.launch_date).toBe("2026-10-06");
    expect(out.generated_at).toBe("2026-10-09");
  });

  test("signups and the waitlist come from list 10 only, each contact once, blacklisted apart", () => {
    expect(out.days.map((d: any) => d.signups)).toEqual([1, 0, 2, 1]);
    // Contact 1 signed up before launch, so it is on the list from day one but no signup.
    expect(out.days.map((d: any) => d.waitlist_total)).toEqual([4, 3, 3, 2]);
    expect(out.days.map((d: any) => d.waitlist_blacklisted)).toEqual([1, 1, 1, 0]);
  });

  test("a contact without SIGNUP_DATE gets its Stockholm createdAt day", () => {
    // createdAt 2026-10-06 23:30 UTC is 7 October 01:30 in Stockholm.
    expect(day(out, "2026-10-07").signups).toBe(2);
  });

  test("forms and placements count launch signups, an empty medium reads as a dash", () => {
    expect(out.signups_by_form).toEqual([
      { form: "bar", count: 1 }, { form: "hero", count: 1 }, { form: "join", count: 1 }, { form: "offer", count: 1 },
    ]);
    expect(out.signups_by_medium).toEqual([
      { medium: "paid_social", count: 2 }, { medium: "-", count: 1 }, { medium: "email", count: 1 },
    ]);
  });

  test("a kickstarter.com GA row never lands in the tap10game.com visitor count", () => {
    // 6 Oct: 10 + 30 sessions on the two tap10game hosts, 500 on www.kickstarter.com.
    expect(day(out, "2026-10-06").ga_sessions).toBe(40);
    expect(day(out, "2026-10-06").ga_users).toBe(28);
    expect(day(out, "2026-10-06").ks_ga_sessions).toBe(500);
    expect(day(out, "2026-10-06").demo_starts).toBe(5);
    // localhost is neither host and counts nowhere.
    expect(day(out, "2026-10-07").ga_sessions).toBe(20);
    expect(day(out, "2026-10-08").ga_sessions).toBe(0);
    expect(day(out, "2026-10-08").ks_ga_sessions).toBe(7);
    expect(out.ga_sources.some((r: any) => r.source === "kickstarter.com")).toBe(false);
    expect(out.ga_sources).toEqual([
      { source: "facebook", medium: "paid", sessions: 25 },
      { source: "google", medium: "organic", sessions: 15 },
    ]);
    expect(out.videos.find((v: any) => v.title === "TAP 10 film")).toEqual({ title: "TAP 10 film", starts: 7, completes: 3 });
  });

  test("average time is weighted by sessions across both tap10game hosts", () => {
    expect(day(out, "2026-10-06").avg_session_sec).toBe(90);
    expect(day(out, "2026-10-08").avg_session_sec).toBeNull();
  });

  test("film and reels are split by title, the film first in the video table", () => {
    const d6 = day(out, "2026-10-06"), d7 = day(out, "2026-10-07");
    expect([d6.film_starts, d6.film_completes, d6.reel_starts, d6.reel_completes]).toEqual([7, 3, 4, 0]);
    expect([d7.film_starts, d7.reel_starts, d7.reel_completes, d7.demo_completes]).toEqual([0, 2, 1, 2]);
    expect(d6.demo_star_clicks).toBe(3);
    expect(out.videos.map((v: any) => v.title)).toEqual(["TAP 10 film", "Reel Ana", "Reel Bo"]);
  });

  test("a day GA does not cover is null, and GA's last day is provisional", () => {
    const d9 = day(out, "2026-10-09");
    for (const k of ["ga_sessions", "ks_ga_sessions", "film_starts", "demo_starts", "avg_session_sec"]) expect(d9[k]).toBeNull();
    expect(day(out, "2026-10-08").provisional).toBe(true);
    expect(out.days.filter((d: any) => d.provisional)).toHaveLength(1);
    expect(out.sources.ga.as_of).toBe("2026-10-08");
  });

  test("ads per day, null past the file's last day", () => {
    expect(day(out, "2026-10-06").ad_spend_sek).toBe(100.5);
    expect(day(out, "2026-10-07").ad_clicks).toBe(20);
    expect(day(out, "2026-10-09").ad_spend_sek).toBeNull();
    expect(out.sources.ads.as_of).toBe("2026-10-08");
  });

  test("followers are the day's last reading, by time, and a day without one is null", () => {
    expect(day(out, "2026-10-07").ks_followers).toBe(194);
    expect(day(out, "2026-10-08").ks_followers).toBeNull();
    expect(day(out, "2026-10-09").ks_followers).toBe(213);
  });

  test("page views sum www.kickstarter.com into Stockholm days, each hour once across files", () => {
    // 15:00 -0700 on 6 Oct is 00:00 on 7 Oct in Stockholm, and it is in both files.
    expect(out.days.map((d: any) => d.ks_pageviews)).toEqual([2, 0, 5, 4]);
  });

  test("today is marked partial, and only today", () => {
    expect(day(out, "2026-10-09").partial).toBe(true);
    expect(out.days.filter((d: any) => d.partial)).toHaveLength(1);
  });

  test("only counts leave the builder, never a contact", () => {
    const text = JSON.stringify(out);
    expect(text).not.toContain("Fixturename");
    expect(text).not.toContain("@");
    expect(text).not.toContain("attributes");
    expect(text).not.toContain('"id"');
  });
});

describe("page views across the October clock change", () => {
  test("each hour lands on its own Stockholm day, CEST before and CET after", () => {
    const dir = mkdtempSync(join(tmpdir(), "tap10-dst-"));
    const pv = tmpJson(dir, "pv.json", {
      stats: [
        // 22:30 UTC is 00:30 on the 25th under CEST (+2).
        { timestamp: "2026-10-24T22:30:00+0000", data: [{ value: "www.kickstarter.com", count: 2 }] },
        // 22:30 UTC is 23:30 on the 26th under CET (+1); a fixed +2 would say the 27th.
        { timestamp: "2026-10-26T22:30:00+0000", data: [{ value: "www.kickstarter.com", count: 1 }] },
      ],
    });
    const { code, out } = build(["--since", "2026-10-24", "--until", "2026-10-27", "--today", "2026-10-28", "--ks-pageviews", pv]);
    expect(code).toBe(0);
    expect(out.days.map((d: any) => [d.date, d.ks_pageviews])).toEqual([
      ["2026-10-27", null], ["2026-10-26", 1], ["2026-10-25", 2], ["2026-10-24", null],
    ]);
  });
});

describe("a missing input is a null, never a number", () => {
  test("with nothing given, every field is null and every source says unavailable", () => {
    const { code, out } = build(["--since", "2026-10-06", "--until", "2026-10-07", "--today", "2026-10-08"]);
    expect(code).toBe(0);
    for (const row of out.days) {
      for (const [k, v] of Object.entries(row)) if (k !== "date") expect(v, `${row.date} ${k}`).toBeNull();
    }
    for (const key of ["signups", "ga", "ads", "ks_followers", "ks_pageviews"]) {
      expect(out.sources[key]).toMatchObject({ as_of: null, text: "unavailable" });
    }
  });
});

describe("it refuses to write", () => {
  const refused = (args: string[], why: RegExp) => {
    const r = build(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(existsSync(r.outPath)).toBe(false);
  };
  const base = ["--since", "2026-10-06", "--until", "2026-10-08", "--today", "2026-10-09"];
  const dir = mkdtempSync(join(tmpdir(), "tap10-refuse-"));

  test("a negative count", () => {
    const ads = tmpJson(dir, "neg.json", [{ date: "2026-10-06", spend_sek: -5, link_clicks: 1 }]);
    refused([...base, "--ads", ads], /negative ad_spend_sek/);
  });

  test("a day missing in the middle of the ads, which would read as no spend", () => {
    const ads = tmpJson(dir, "gap.json", [
      { date: "2026-10-06", spend_sek: 1, link_clicks: 1 },
      { date: "2026-10-08", spend_sek: 1, link_clicks: 1 },
    ]);
    refused([...base, "--ads", ads], /skip 2026-10-07/);
  });

  test("a GA report that holds more rows than it returned", () => {
    const ga = JSON.parse(readFileSync(join(FIX, "ga.json"), "utf8"));
    ga.daily.data.rowCount = ga.daily.data.rows.length + 1;
    refused([...base, "--ga", tmpJson(dir, "trunc.json", ga)], /truncated/);
  });

  test("a GA report with rows and no rowCount, since truncation cannot be ruled out", () => {
    const ga = JSON.parse(readFileSync(join(FIX, "ga.json"), "utf8"));
    delete ga.events.data.rowCount;
    refused([...base, "--ga", tmpJson(dir, "norc.json", ga)], /no rowCount/);
  });

  test("two page view files that disagree about the same hour", () => {
    const a = tmpJson(dir, "pa.json", { stats: [{ timestamp: "2026-10-06T10:00:00+0000", data: [{ value: "www.kickstarter.com", count: 3 }] }] });
    const b = tmpJson(dir, "pb.json", { stats: [{ timestamp: "2026-10-06T10:00:00+0000", data: [{ value: "www.kickstarter.com", count: 4 }] }] });
    refused([...base, "--ks-pageviews", a, "--ks-pageviews", b], /disagree about the hour/);
  });
});

describe("the GA property also holds the Kickstarter page", () => {
  test("a GA report of kickstarter.com alone gives tap10game.com zero, not the Kickstarter count", () => {
    const base = ["--since", "2026-10-06", "--until", "2026-10-08", "--today", "2026-10-09"];
    const dir = mkdtempSync(join(tmpdir(), "tap10-ksonly-"));
    const ga = {
      property: "542188652", start: "2026-10-06", end: "2026-10-06",
      daily: gaReport([[["20261006", "www.kickstarter.com"], [321, 300, 40]]]),
      events: gaReport([]), videos: gaReport([]),
      sources: gaReport([[["kickstarter.com", "referral", "www.kickstarter.com"], [321]]]),
    };
    const { code, out } = build([...base, "--ga", tmpJson(dir, "ksonly.json", ga)]);
    expect(code).toBe(0);
    expect(day(out, "2026-10-06").ga_sessions).toBe(0);
    expect(day(out, "2026-10-06").ks_ga_sessions).toBe(321);
    expect(out.ga_sources).toEqual([]);
  });
});
