// loadPage fakes browser globals only while a page file runs, then every one goes back.
// Why and how: docs/TESTS-PAGE-HARNESS.md, "Globals the harness replaces"

import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  CART_ADD,
  CODE_VISIBLE_MS,
  FakeObserver,
  RESTORE_WAIT_MS,
  codeAnswer,
  loadPage,
  restorePageGlobals,
} from "./page-harness.ts";

const KEYS = [
  "window", "document", "navigator", "IntersectionObserver", "fetch",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
];
const g = globalThis as any;
const before = Object.fromEntries(KEYS.map((key) => [key, { present: key in g, value: g[key] }]));
const bunSetTimeout = setTimeout;
const sleep = (ms: number) => new Promise((done) => bunSetTimeout(done, ms));

afterAll(restorePageGlobals);

function expectOriginals() {
  for (const key of KEYS) {
    expect({ key, present: key in g }).toEqual({ key, present: before[key].present });
    if (before[key].present) expect(g[key]).toBe(before[key].value);
  }
}

test("before any page loads, fetch, navigator and the timers are Bun's own, and there is no DOM", () => {
  for (const key of ["fetch", "navigator", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]) {
    expect({ key, present: before[key].present }).toEqual({ key, present: true });
  }
  expect(before.navigator.value.userAgent).toStartWith("Bun/");
  expect(before.window.present).toBe(false);
  expect(before.document.present).toBe(false);
  expect(before.IntersectionObserver.present).toBe(false);
});

test("while a page is driven, it sees every fake", async () => {
  const page = await loadPage({ body: codeAnswer });
  expect(g.window).toBe(page.window);
  expect(g.document).toBe(page.document);
  expect(g.navigator).toBe(page.window.navigator);
  expect(g.IntersectionObserver).toBe(FakeObserver);
  expect(g.fetch).not.toBe(before.fetch.value);

  await g.fetch("/cart/clear.js", { method: "POST" });
  expect(page.calls.some((call) => call.url === "/cart/clear.js")).toBe(true);
});

test("restorePageGlobals puts back the exact objects from before the first page", async () => {
  // A second load must not mistake the first page's fakes for the originals.
  await loadPage({ body: codeAnswer });
  await loadPage({ body: codeAnswer });
  await restorePageGlobals();
  expectOriginals();
});

test("restoring twice, or with nothing replaced, changes nothing", async () => {
  await restorePageGlobals();
  await restorePageGlobals();
  expectOriginals();
});

test("a page loaded after a restore gets fresh fakes, and the next restore still finds the originals", async () => {
  const page = await loadPage({ body: codeAnswer });
  expect(g.document).toBe(page.document);
  await restorePageGlobals();
  expectOriginals();
});

test(
  "a page left mid-redirect lands its redirect before the restore, and nothing throws after it",
  async () => {
    const errors: unknown[] = [];
    const onError = (err: unknown) => void errors.push(err);
    process.on("unhandledRejection", onError);
    process.on("uncaughtException", onError);
    try {
      const page = await loadPage({ body: codeAnswer });
      await page.submit();
      await page.until(() => page.calls.some((call) => call.url === CART_ADD), "the cart to be built");
      expect(page.navigations).toEqual([]);

      await restorePageGlobals();
      expect(page.navigations).toHaveLength(1);
      expectOriginals();

      // Past where the redirect would have fired into Bun's own globals.
      await sleep(CODE_VISIBLE_MS + 500);
      expect(errors).toEqual([]);
    } finally {
      process.off("unhandledRejection", onError);
      process.off("uncaughtException", onError);
    }
  },
  RESTORE_WAIT_MS + CODE_VISIBLE_MS + 5000
);

test(
  "a page timer past the bound is stopped, never left to fire after the restore",
  async () => {
    await loadPage({ body: codeAnswer });
    let fired = false;
    g.setTimeout(() => {
      fired = true;
      g.document.title;
    }, RESTORE_WAIT_MS + 300);

    await restorePageGlobals();
    expectOriginals();
    await sleep(800);
    expect(fired).toBe(false);
  },
  RESTORE_WAIT_MS + 5000
);

test("every test file that loads a page through the harness registers afterAll(restorePageGlobals)", () => {
  const dir = import.meta.dir;
  const usesHarness = /import\s*\{[^}]*\bloadPage\b[^}]*\}\s*from\s*["']\.\/page-harness(\.ts)?["']/;
  const pageFiles = readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => usesHarness.test(readFileSync(join(dir, name), "utf8")));

  // Not vacuous: the three gift page files and this one.
  expect(pageFiles.length).toBeGreaterThanOrEqual(4);
  const missing = pageFiles.filter((name) => !/afterAll\(\s*restorePageGlobals\s*\)/.test(readFileSync(join(dir, name), "utf8")));
  expect(missing).toEqual([]);
});
