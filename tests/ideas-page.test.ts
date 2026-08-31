// The real /ideas page, loaded into a DOM and driven the way a person drives it.
//
// Nothing here re-implements the page. Its script is inline, so it is lifted out of the
// HTML and evaluated against the DOM, fetch, console and storage this file controls,
// exactly as tests/index-period.test.ts does for the Marketing HQ page. The lifting
// fails loudly if the page stops looking that way.
//
// The default payload is the repo's own data/ideas.json, so these tests read the same
// six ideas a person looking at the deployed page reads.

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const HTML = readFileSync(join(REPO, "public", "ideas.html"), "utf8");
const SEED = JSON.parse(readFileSync(join(REPO, "data", "ideas.json"), "utf8"));

const LP = "lying-pirates";
const TAP = "tap10";

/** The page's own script, ready to evaluate, with its self-start call removed. */
function pageScript(): string {
  const tag = HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!tag) throw new Error("public/ideas.html has no inline <script> any more, this harness is stale");
  const withStart = tag[1];
  const src = withStart.replace(/\nload\(\);\s*$/, "\n");
  if (src === withStart) throw new Error("the page no longer ends by calling load(), this harness is stale");
  return src;
}

/** A localStorage a test can carry from one page load to the next, which is a reload. */
function makeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

type Payload = { brands: { id: string; label: string }[]; ideas: any[] };

/** Ask the harness to fail the fetch instead of answering it: a status, or no reply at all. */
type Failure = { fail: number | "throw" };

function payload(extra: any[] = [], brands = SEED.brands): Payload {
  return { brands, ideas: [...SEED.ideas, ...extra] };
}

type Page = {
  document: any;
  window: any;
  errors: string[];
  /** Every fetch the page made, in order. */
  calls: { url: string; method: string; body: any }[];
  storage: ReturnType<typeof makeStorage>;
  /** The brand tab labels on screen, in order, without their counts. */
  tabs: () => string[];
  activeTab: () => string;
  /** Click a brand tab by its label. */
  pickBrand: (label: string) => Promise<void>;
  /** The idea titles on screen right now. */
  titles: () => string[];
  bodies: () => string[];
  type: (needle: string) => Promise<void>;
  count: () => string;
  text: (id: string) => string;
  add: (title: string, body: string) => Promise<void>;
  /** Load the same page again with the same storage: a browser reload. */
  reload: (next?: Payload) => Promise<Page>;
  /** Let the API answer properly and run load() again on this same page. */
  recover: (next: Payload) => Promise<void>;
};

/** Load the page with whatever /api/ideas should answer. */
async function loadPage(data: Payload | Failure = payload(), storage = makeStorage()): Promise<Page> {
  const window = new Window({
    url: "https://marketing.nordicpirate.com/ideas",
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
    },
  });
  const document = window.document;
  document.write(HTML);

  Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });
  if (window.localStorage !== storage) throw new Error("could not put a test localStorage on the window");

  const errors: string[] = [];
  const calls: { url: string; method: string; body: any }[] = [];
  let failure: number | "throw" | undefined = (data as Failure).fail;
  let current: Payload = failure === undefined ? (data as Payload) : payload();

  const fetchStub = async (url: string, init: any = {}) => {
    const method = (init.method || "GET").toUpperCase();
    let body: any = null;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    if (url !== "/api/ideas") throw new Error(`the page fetched ${url}, which this harness does not answer`);

    if (failure !== undefined) {
      // "throw" is the browser's own failure, what fetch does when nothing answers.
      if (failure === "throw") throw new TypeError("Failed to fetch");
      // A status, with the body the server really sends: JSON, so a page that parses
      // before checking the status gets something that looks like data.
      return new Response(JSON.stringify({ error: "The ideas store is unavailable. This has been logged for an operator." }), {
        status: failure,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST") {
      // Stand in for the store: keep what the page sent, so the next GET shows it.
      const idea = {
        id: "new-" + calls.length,
        brand: body.brand,
        title: body.title,
        body: body.body,
        created_at: "2026-08-31T12:00:00.000Z",
        created_by: "portal",
      };
      current = { ...current, ideas: [...current.ideas, idea] };
      return new Response(JSON.stringify({ idea }), { status: 201, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } });
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
    pageScript() + "\nreturn load;"
  )(window, document, fetchStub, consoleStub, window.navigator);
  await start();

  const settle = () => new Promise((done) => setTimeout(done, 0));
  const el = (id: string) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`no #${id} on the page`);
    return found;
  };
  const tabEls = () => [...document.querySelectorAll(".brandtab")];
  const label = (tab: any) => tab.textContent.replace(/\s*\d+\s*$/, "").trim();

  const page: Page = {
    document,
    window,
    errors,
    calls,
    storage,
    tabs: () => tabEls().map(label),
    activeTab: () => {
      const active = tabEls().filter((t: any) => t.classList.contains("active"));
      if (active.length !== 1) throw new Error(`expected one active brand tab, found ${active.length}`);
      return label(active[0]);
    },
    async pickBrand(wanted: string) {
      const tab = tabEls().find((t: any) => label(t) === wanted);
      if (!tab) throw new Error(`no brand tab labelled "${wanted}"`);
      (tab as any).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await settle();
    },
    titles: () => [...el("ideas").querySelectorAll("h3")].map((h: any) => h.textContent),
    bodies: () => [...el("ideas").querySelectorAll("p")].map((p: any) => p.textContent),
    async type(needle: string) {
      const input = el("filter");
      input.value = needle;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle();
    },
    count: () => el("count").textContent.trim(),
    text: (id: string) => el(id).textContent.replace(/\s+/g, " ").trim(),
    async add(title: string, body: string) {
      el("title").value = title;
      el("body").value = body;
      el("addform").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      await settle();
      await settle();
    },
    reload: (next?: Payload) => loadPage(next || current, storage),
    async recover(next: Payload) {
      failure = undefined;
      current = next;
      await start();
    },
  };

  return page;
}

describe("brands are built from the data", () => {
  test("one tab per brand the API sent, in that order", async () => {
    const page = await loadPage();
    expect(page.tabs()).toEqual(["Lying Pirates", "TAP 10: Inventions"]);
    expect(page.errors).toEqual([]);
  });

  test("a third brand needs a data change and nothing else", async () => {
    // No edit to ideas.html between this test and the one above it. That is the point.
    const brands = [...SEED.brands, { id: "third-brand", label: "Third Brand" }];
    const extra = [
      {
        id: "third-1",
        brand: "third-brand",
        title: "An idea for a brand that did not exist yesterday",
        body: "Filed under the third brand.",
        created_at: "2026-08-31T10:00:00.000Z",
        created_by: "portal",
      },
    ];
    const page = await loadPage(payload(extra, brands));

    expect(page.tabs()).toEqual(["Lying Pirates", "TAP 10: Inventions", "Third Brand"]);
    await page.pickBrand("Third Brand");
    expect(page.titles()).toEqual(["An idea for a brand that did not exist yesterday"]);
    expect(page.errors).toEqual([]);
  });

  test("no brand name is written into the markup, only into the data", async () => {
    for (const brand of SEED.brands) expect(HTML).not.toContain(brand.label);
    for (const idea of SEED.ideas) expect(HTML).not.toContain(idea.title);
  });

  test("each tab carries how many ideas that brand has", async () => {
    const page = await loadPage();
    const tabs = [...page.document.querySelectorAll(".brandtab")].map((t: any) => t.textContent);
    expect(tabs[0]).toContain("3");
    expect(tabs[1]).toContain("3");
  });
});

describe("one brand at a time, and never the other one's ideas", () => {
  test("the first brand is showing, with only its own three ideas", async () => {
    const page = await loadPage();
    expect(page.activeTab()).toBe("Lying Pirates");

    const lp = SEED.ideas.filter((i: any) => i.brand === LP).map((i: any) => i.title);
    expect(page.titles().sort()).toEqual(lp.sort());
    expect(page.count()).toBe("3 idéer");
  });

  test("switching brand swaps the whole list, with nothing left over", async () => {
    const page = await loadPage();
    await page.pickBrand("TAP 10: Inventions");

    const tap = SEED.ideas.filter((i: any) => i.brand === TAP).map((i: any) => i.title);
    expect(page.titles().sort()).toEqual(tap.sort());

    // Not one Lying Pirates idea, in a title or in a body.
    const onScreen = page.text("ideas");
    for (const idea of SEED.ideas.filter((i: any) => i.brand === LP)) {
      expect(onScreen).not.toContain(idea.title);
      expect(onScreen).not.toContain(idea.body);
    }
  });

  test("a brand with no ideas says so instead of showing another brand's", async () => {
    const brands = [...SEED.brands, { id: "empty-brand", label: "Empty Brand" }];
    const page = await loadPage(payload([], brands));
    await page.pickBrand("Empty Brand");

    expect(page.titles()).toEqual([]);
    expect(page.text("ideas")).toContain("Inga idéer för Empty Brand än");
  });
});

describe("the chosen brand survives a reload", () => {
  test("coming back lands on the brand that was picked, not on the first one", async () => {
    const page = await loadPage();
    await page.pickBrand("TAP 10: Inventions");

    const again = await page.reload();
    expect(again.activeTab()).toBe("TAP 10: Inventions");
    expect(again.titles().sort()).toEqual(
      SEED.ideas.filter((i: any) => i.brand === TAP).map((i: any) => i.title).sort()
    );
  });

  test("a remembered brand that no longer exists falls back to the first one", async () => {
    // Otherwise removing a brand from the data leaves whoever had it selected staring
    // at an empty page with no active tab.
    const page = await loadPage(payload(), makeStorage({ "np-ideas-brand": "a-brand-that-was-removed" }));
    expect(page.activeTab()).toBe("Lying Pirates");
    expect(page.titles()).toHaveLength(3);
  });
});

describe("the filter", () => {
  test("narrows to what matches, in the title or in the body, whatever the case", async () => {
    const page = await loadPage();
    await page.pickBrand("TAP 10: Inventions");

    // A word from one title.
    await page.type("dishwasher");
    expect(page.titles()).toEqual(["The dishwasher is older than the airplane."]);

    // The same word in capitals, and one that is only in a body.
    await page.type("DISHWASHER");
    expect(page.titles()).toEqual(["The dishwasher is older than the airplane."]);

    await page.type("selfie stick");
    expect(page.titles()).toEqual(["I gave the same three cards to a 9-year-old and a 40-year-old."]);
    expect(page.count()).toBe("1 av 3 idéer");
  });

  test("clearing it brings the whole brand back", async () => {
    const page = await loadPage();
    await page.type("Liar");
    expect(page.titles()).toHaveLength(1);

    await page.type("");
    expect(page.titles()).toHaveLength(3);
    expect(page.count()).toBe("3 idéer");
  });

  test("it never reaches past the selected brand", async () => {
    const page = await loadPage();
    // A word that is only in a TAP 10 idea, typed while Lying Pirates is showing.
    await page.type("dishwasher");
    expect(page.titles()).toEqual([]);
    expect(page.text("ideas")).toContain("Ingen idé matchar sökningen");
  });

  test("filtering does not reload the page or ask the server again", async () => {
    const page = await loadPage();
    const before = page.calls.length;
    await page.type("game");
    await page.type("");
    expect(page.calls.length).toBe(before);
  });
});

describe("adding an idea from the page", () => {
  test("files it under the brand on screen and shows it straight away", async () => {
    const page = await loadPage();
    await page.pickBrand("TAP 10: Inventions");
    await page.add("A hook typed on the portal", "Written in the browser, not in the seed.");

    const sent = page.calls.filter((c) => c.method === "POST");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({
      brand: TAP,
      title: "A hook typed on the portal",
      body: "Written in the browser, not in the seed.",
    });

    expect(page.titles()).toContain("A hook typed on the portal");
    expect(page.count()).toBe("4 idéer");
    expect(page.text("formnote")).toBe("Sparad.");

    // The form is empty again, and the other brand is untouched.
    expect(page.document.getElementById("title").value).toBe("");
    await page.pickBrand("Lying Pirates");
    expect(page.titles()).toHaveLength(3);
  });

  test("an empty field is refused on the page, without a request", async () => {
    const page = await loadPage();
    const before = page.calls.length;

    await page.add("", "A body with no title");
    await page.add("A title with no body", "   ");

    expect(page.calls.length).toBe(before);
    expect(page.text("formnote")).toContain("Både rubrik och beskrivning behövs");
  });
});

describe("when the list cannot be fetched, the page says so instead of going blank", () => {
  test("a 503 from a store that refuses to read is shown, in Swedish, with the status", async () => {
    const page = await loadPage({ fail: 503 });
    const shown = page.text("ideas");

    expect(shown).toContain("Idéerna kunde inte hämtas");
    expect(shown).toContain("503");
    expect(shown).toContain("Ladda om sidan");

    // The failure that used to happen: no tabs, no ideas and nothing else either.
    expect(page.tabs()).toEqual([]);
    expect(page.titles()).toEqual([]);
    expect(shown.length).toBeGreaterThan(40);
  });

  test("the 503 body is not mistaken for data, so the page never claims there are no brands", async () => {
    // The store's 503 is JSON, so a page that parses before checking the status gets an
    // object with no brands in it and renders "no brands are set up yet", which is a lie.
    const page = await loadPage({ fail: 503 });
    expect(page.text("ideas")).not.toContain("Inga varumärken");
  });

  test("saving is closed off while the list is unreachable, rather than failing silently", async () => {
    const page = await loadPage({ fail: 503 });
    expect(page.document.getElementById("savebtn").disabled).toBe(true);
    expect(page.text("formnote")).toContain("går inte att spara");
  });

  test("no reply at all is shown too, not swallowed into a blank page", async () => {
    const page = await loadPage({ fail: "throw" });
    const shown = page.text("ideas");

    expect(shown).toContain("Idéerna kunde inte hämtas");
    expect(shown).toContain("Ingen kontakt med servern");
    expect(page.document.getElementById("savebtn").disabled).toBe(true);
    // It was logged as well as shown.
    expect(page.errors.length).toBeGreaterThan(0);
  });

  test("every failure leaves something on screen, whatever the status", async () => {
    for (const fail of [500, 502, 503, "throw"] as const) {
      const page = await loadPage({ fail });
      expect(page.text("ideas").trim()).not.toBe("");
      expect(page.text("ideas")).toContain("Idéerna kunde inte hämtas");
    }
  });

  test("a load that works after a failure clears the error and lets people save again", async () => {
    const page = await loadPage({ fail: 503 });
    expect(page.document.getElementById("savebtn").disabled).toBe(true);

    await page.recover(payload());

    expect(page.titles()).toHaveLength(3);
    expect(page.text("ideas")).not.toContain("kunde inte hämtas");
    expect(page.tabs()).toEqual(["Lying Pirates", "TAP 10: Inventions"]);
    expect(page.document.getElementById("savebtn").disabled).toBe(false);
  });
});

describe("what the page shows is text, and what it looks like is the portal", () => {
  test("an idea with markup in it is shown, not run", async () => {
    const nasty = [
      {
        id: "nasty-1",
        brand: LP,
        title: "<img src=x onerror=alert(1)>",
        body: "<b>not bold</b>",
        created_at: "2026-08-31T11:00:00.000Z",
        created_by: "portal",
      },
    ];
    const page = await loadPage(payload(nasty));

    expect(page.titles()).toContain("<img src=x onerror=alert(1)>");
    expect(page.bodies()).toContain("<b>not bold</b>");
    // As characters on screen, not as elements in the list.
    expect(page.document.getElementById("ideas").querySelectorAll("img")).toHaveLength(0);
    expect(page.document.getElementById("ideas").querySelectorAll("b")).toHaveLength(0);
  });

  test("the portal's palette, and none of the post-it colours Lucas rejected", async () => {
    for (const banned of ["#fef3c7", "#fef9c3", "#fde68a", "#fffbeb", "#fef08a", "#fde047"]) {
      expect(HTML.toLowerCase()).not.toContain(banned);
    }
    for (const wanted of ["#f2ede4", "#171717", "#c96a3d", "Asul", "Inter"]) {
      expect(HTML).toContain(wanted);
    }
  });

  test("the page says it in Swedish", async () => {
    const page = await loadPage();
    for (const word of ["Idébank", "Ny idé", "Rubrik", "Beskrivning", "Lägg till idé"]) {
      expect(page.text("ideas") + HTML).toContain(word);
    }
  });
});
