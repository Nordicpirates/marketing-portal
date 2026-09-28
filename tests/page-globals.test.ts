// loadPage fakes browser globals only while a page file runs, then every one goes back.
// Why and how: docs/TESTS-PAGE-HARNESS.md, "Globals the harness replaces"

import { afterAll, expect, test } from "bun:test";
import { FakeObserver, codeAnswer, loadPage, restorePageGlobals } from "./page-harness.ts";

const KEYS = ["window", "document", "navigator", "IntersectionObserver", "fetch"];
const g = globalThis as any;
const before = Object.fromEntries(KEYS.map((key) => [key, { present: key in g, value: g[key] }]));

afterAll(restorePageGlobals);

function expectOriginals() {
  for (const key of KEYS) {
    expect({ key, present: key in g }).toEqual({ key, present: before[key].present });
    if (before[key].present) expect(g[key]).toBe(before[key].value);
  }
}

test("before any page loads, fetch and navigator are Bun's own and there is no DOM", () => {
  expect(before.fetch.present).toBe(true);
  expect(before.window.present).toBe(false);
  expect(before.document.present).toBe(false);
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
  restorePageGlobals();
  expectOriginals();
});

test("restoring twice, or with nothing replaced, changes nothing", () => {
  restorePageGlobals();
  restorePageGlobals();
  expectOriginals();
});

test("a page loaded after a restore gets fresh fakes, and the next restore still finds the originals", async () => {
  const page = await loadPage({ body: codeAnswer });
  expect(g.document).toBe(page.document);
  restorePageGlobals();
  expectOriginals();
});
