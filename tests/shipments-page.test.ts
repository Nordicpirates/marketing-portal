// The real /shipments page, loaded into a DOM and driven the way a person drives it,
// the same way tests/assets-page.test.ts drives the assets page: the inline script is
// lifted out of the HTML and evaluated against the DOM, fetch, console and storage this
// file controls.

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "fs";
import { join } from "path";
import { GAMES, NOTION_URL, PLATFORMS, SHIPPED_FROM } from "../lib/shipments.ts";

const REPO = join(import.meta.dir, "..");
const HTML = readFileSync(join(REPO, "public", "shipments.html"), "utf8");

/** Four rows the way /api/shipments hands them over. Deliberately out of date order. */
const ROWS = [
  {
    id: "r1", url: "https://www.notion.so/r1", creator: "Quackalope", game: "Cities of Greed", quantity: 1, sent: "2025-11-24",
    status: "Sent", shipped_from: "", platform: "YouTube", contact_email: "", tracking: "", content_link: "", paid_usd: 200,
    notes: "Wanted 200 USD", logged_by: "Bengt", created: "2026-09-14T10:00:00.000Z",
  },
  {
    id: "r2", url: "https://www.notion.so/r2", creator: "Meeple University", game: "Cities of Greed", quantity: 2, sent: "2025-11-20",
    status: "Content published", shipped_from: "US warehouse", platform: "YouTube", contact_email: "hi@meeple.example",
    tracking: "https://track.example/123", content_link: "https://www.youtube.com/watch?v=abc", paid_usd: null,
    notes: "", logged_by: "Lucas", created: "2026-09-14T10:01:00.000Z",
  },
  {
    id: "r3", url: "", creator: "Nordic Board Gamer", game: "Lying Pirates - Big Box", quantity: 1, sent: "2026-09-10",
    status: "Sent", shipped_from: "Stockholm office", platform: "Instagram", contact_email: "", tracking: "", content_link: "",
    paid_usd: null, notes: "Big Box plus Kraken", logged_by: "Mikaela", created: "2026-09-14T10:02:00.000Z",
  },
  {
    id: "r4", url: "", creator: "No Date Yet", game: "TAP 10: Inventions", quantity: 3, sent: null,
    status: "Planned", shipped_from: "", platform: "", contact_email: "", tracking: "javascript:alert(1)", content_link: "",
    paid_usd: null, notes: "", logged_by: "Bengt", created: "2026-09-14T10:03:00.000Z",
  },
];

/** The page's own script, ready to evaluate, with its self-start call removed. */
function pageScript(): string {
  const tag = HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!tag) throw new Error("public/shipments.html has no inline <script> any more, this harness is stale");
  const withStart = tag[1];
  const src = withStart.replace(/\nload\(\);\s*$/, "\n");
  if (src === withStart) throw new Error("the page no longer ends by calling load(), this harness is stale");
  return src;
}

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

type Answer = {
  rows?: any[];
  configured?: boolean;
  /** Fail the GET: a status with the error JSON the server really sends, or no reply at all. */
  fail?: number | "throw";
  error?: string;
  /** Fail the POST with a status and the sentence the server would send. */
  postFail?: { status: number; error: string };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function loadPage(answer: Answer = { rows: ROWS }, storage = makeStorage()) {
  const window = new Window({
    url: "https://marketing.nordicpirate.com/shipments",
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
    },
  });
  const document = window.document;
  document.write(HTML);
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });

  const errors: string[] = [];
  const calls: { url: string; method: string; body: any }[] = [];
  let rows = answer.rows ? [...answer.rows] : [];

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
    if (url !== "/api/shipments") throw new Error(`the page fetched ${url}, which this harness does not answer`);

    if (method === "GET") {
      if (answer.fail === "throw") throw new TypeError("Failed to fetch");
      if (typeof answer.fail === "number") {
        return json({ error: answer.error ?? `Notion answered ${answer.fail}.`, notion_status: answer.fail, notion_url: NOTION_URL }, answer.fail);
      }
      if (answer.configured === false) return json({ configured: false, notion_url: NOTION_URL, shipments: [] });
      return json({ configured: true, notion_url: NOTION_URL, shipments: rows });
    }
    if (method === "POST") {
      if (answer.postFail) return json({ error: answer.postFail.error }, answer.postFail.status);
      const shipment = {
        id: `new-${calls.length}`, url: "https://www.notion.so/new", creator: body.creator, game: body.game, quantity: body.quantity,
        sent: body.sent, status: "Sent", shipped_from: body.shipped_from || "", platform: body.platform || "",
        contact_email: body.contact_email || "", tracking: body.tracking || "", content_link: "", paid_usd: null,
        notes: body.notes || "", logged_by: body.logged_by, created: "2026-09-14T12:00:00.000Z",
      };
      rows = [...rows, shipment];
      return json({ shipment }, 201);
    }
    throw new Error(`unexpected ${method}`);
  };
  const consoleStub = { ...console, error: (...args: any[]) => void errors.push(args.map(String).join(" ")) };

  const start = new Function(
    "window",
    "document",
    "fetch",
    "console",
    "location",
    pageScript() + "\nreturn load;"
  )(window, document, fetchStub, consoleStub, window.location);
  await start();

  const settle = () => new Promise((done) => setTimeout(done, 0));
  const el = (id: string) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`no #${id} on the page`);
    return found;
  };
  const rowEls = () => [...document.querySelectorAll(".row")];

  return {
    document,
    errors,
    calls,
    storage,
    el,
    text: (id: string) => el(id).textContent.replace(/\s+/g, " ").trim(),
    rowEls,
    rowText: (n: number) => (rowEls()[n] as any).textContent.replace(/\s+/g, " ").trim(),
    rowLinks: (n: number) => [...(rowEls()[n] as any).querySelectorAll("a")].map((a: any) => [a.textContent, a.getAttribute("href")]),
    creators: () => rowEls().map((r: any) => r.querySelector(".who").textContent),
    tiles: () =>
      [...document.querySelectorAll(".tile")].map((t: any) => ({
        n: t.querySelector(".n").textContent,
        l: t.querySelector(".l").textContent,
        u: t.querySelector(".u").textContent,
      })),
    options: (id: string) => [...el(id).querySelectorAll("option")].map((o: any) => o.value),
    fieldsShut: () => (el("fields") as any).disabled === true,
    overviewHidden: () => (el("overview") as any).style.display === "none",
    noticeLinks: () => [...el("notice").querySelectorAll("a")].map((a: any) => a.getAttribute("href")),
    async type(needle: string) {
      const input = el("filter") as any;
      input.value = needle;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle();
    },
    async save(fields: Record<string, string>) {
      for (const [id, value] of Object.entries(fields)) (el(id) as any).value = value;
      el("logform").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      // The handler is a chain of awaits: the POST, its json(), then load() with its own
      // fetch and json(), then the finally. Settle enough times to get past all of them.
      for (let n = 0; n < 8; n++) await settle();
    },
  };
}

const FILLED = {
  creator: "Board Game Barrage",
  game: "TAP 10: Inventions",
  quantity: "2",
  sent: "2026-09-14",
  shipped_from: "Stockholm office",
  platform: "YouTube",
  contact_email: "bgb@example.com",
  tracking: "https://t.example/1",
  notes: "Prototype copy",
  logged_by: "Lucas",
};

describe("the overview", () => {
  test("one tile for the total and one per game, in the game list's order, with rows and units", async () => {
    const page = await loadPage();
    expect(page.tiles()).toEqual([
      { n: "4", l: "shipments in total", u: "7 units" },
      { n: "1", l: "Lying Pirates - Big Box", u: "1 unit" },
      { n: "2", l: "Cities of Greed", u: "3 units" },
      { n: "1", l: "TAP 10: Inventions", u: "3 units" },
    ]);
    expect(page.errors).toEqual([]);
  });

  test("the Notion link at the top goes to the database", async () => {
    const page = await loadPage();
    expect(page.el("notion-top").getAttribute("href")).toBe(NOTION_URL);
    expect(page.el("notion-top").getAttribute("target")).toBe("_blank");
  });
});

describe("the list", () => {
  test("newest Sent first, rows with no date last, and the count", async () => {
    const page = await loadPage();
    expect(page.creators()).toEqual(["Nordic Board Gamer", "Quackalope", "Meeple University", "No Date Yet"]);
    expect(page.text("count")).toBe("4 shipments");
  });

  test("each row shows what was sent, when, from where, its status, the notes and who logged it", async () => {
    const page = await loadPage();
    const nordic = page.rowText(0);
    for (const bit of ["Nordic Board Gamer", "1 × Lying Pirates - Big Box", "from Stockholm office", "Sent", "Instagram", "Big Box plus Kraken", "logged by Mikaela"]) {
      expect(nordic).toContain(bit);
    }
    const quack = page.rowText(1);
    expect(quack).toContain("24 Nov 2025");
    expect(quack).toContain("Paid $200");
    expect(quack).toContain("Wanted 200 USD");

    const meeple = page.rowText(2);
    expect(meeple).toContain("2 × Cities of Greed");
    expect(meeple).toContain("from US warehouse");
    expect(meeple).toContain("Content published");
    expect(page.rowLinks(2)).toEqual([
      ["Tracking", "https://track.example/123"],
      ["Content", "https://www.youtube.com/watch?v=abc"],
      ["Notion row", "https://www.notion.so/r2"],
    ]);

    expect(page.rowText(3)).toContain("no date");
    expect(page.rowText(3)).toContain("Planned");
  });

  test("a tracking value that is not an http address never becomes a link", async () => {
    const page = await loadPage();
    expect(page.rowLinks(3)).toEqual([]);
    expect(page.document.querySelectorAll('a[href^="javascript:"]')).toHaveLength(0);
  });

  test("an empty list says so instead of leaving a blank", async () => {
    const page = await loadPage({ rows: [] });
    expect(page.text("list")).toContain("No shipments logged yet");
    expect(page.text("count")).toBe("0 shipments");
    expect(page.tiles()).toEqual([{ n: "0", l: "shipments in total", u: "0 units" }]);
    expect(page.fieldsShut()).toBe(false);
  });

  test("a creator name with markup in it is shown, not run", async () => {
    const nasty = { ...ROWS[0], id: "n", creator: "<img src=x onerror=alert(1)>", notes: "<b>not bold</b>" };
    const page = await loadPage({ rows: [nasty] });
    expect(page.creators()).toEqual(["<img src=x onerror=alert(1)>"]);
    expect(page.el("list").querySelectorAll("img")).toHaveLength(0);
    // The row's own "1 × game" line is bold by design; the note's tags must not be.
    expect([...page.el("list").querySelectorAll("b")].map((b: any) => b.textContent)).toEqual(["1 × Cities of Greed"]);
    expect(page.rowText(0)).toContain("<b>not bold</b>");
  });
});

describe("the search box", () => {
  test("narrows on creator, game, platform or a word in the notes, whatever the case", async () => {
    const page = await loadPage();
    await page.type("MEEPLE");
    expect(page.creators()).toEqual(["Meeple University"]);
    expect(page.text("count")).toBe("1 of 4 shipments");

    await page.type("instagram");
    expect(page.creators()).toEqual(["Nordic Board Gamer"]);

    await page.type("kraken");
    expect(page.creators()).toEqual(["Nordic Board Gamer"]);

    await page.type("cities of greed");
    expect(page.creators()).toEqual(["Quackalope", "Meeple University"]);
  });

  test("clearing it brings everything back, and no match says so", async () => {
    const page = await loadPage();
    await page.type("zzz-nothing-has-this");
    expect(page.creators()).toEqual([]);
    expect(page.text("list")).toContain("Nothing matches");
    await page.type("");
    expect(page.creators()).toHaveLength(4);
  });

  test("searching never asks the server again", async () => {
    const page = await loadPage();
    const before = page.calls.length;
    await page.type("meeple");
    await page.type("");
    expect(page.calls.length).toBe(before);
  });
});

describe("the form", () => {
  test("the selects carry exactly the database's options, and Sent starts on today", async () => {
    const page = await loadPage();
    expect(page.options("game")).toEqual([...GAMES]);
    expect(page.options("shipped_from")).toEqual(["", ...SHIPPED_FROM]);
    expect(page.options("platform")).toEqual(["", ...PLATFORMS]);
    expect((page.el("sent") as any).value).toBe(new Date().toLocaleDateString("sv-SE"));
    expect((page.el("quantity") as any).value).toBe("1");
    expect(page.fieldsShut()).toBe(false);
  });

  test("saving posts the row as JSON, shows it straight away, and says Saved", async () => {
    const page = await loadPage();
    await page.save(FILLED);

    const sent = page.calls.filter((c) => c.method === "POST");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ ...FILLED, quantity: 2 });

    expect(page.text("formnote")).toBe("Saved.");
    expect(page.creators()[0]).toBe("Board Game Barrage");
    expect(page.text("count")).toBe("5 shipments");
    expect(page.tiles()[0]).toEqual({ n: "5", l: "shipments in total", u: "9 units" });

    // The parcel fields are empty again; the name and the game stay for the next one.
    expect((page.el("creator") as any).value).toBe("");
    expect((page.el("notes") as any).value).toBe("");
    expect((page.el("quantity") as any).value).toBe("1");
    expect((page.el("logged_by") as any).value).toBe("Lucas");
    expect(page.storage.getItem("np-shipments-logged-by")).toBe("Lucas");
    expect(page.fieldsShut()).toBe(false);
  });

  test("the name is remembered for the next visit", async () => {
    const page = await loadPage({ rows: ROWS }, makeStorage({ "np-shipments-logged-by": "Mikaela" }));
    expect((page.el("logged_by") as any).value).toBe("Mikaela");
  });

  test("a missing creator or name is refused on the page, without a request", async () => {
    const page = await loadPage();
    const before = page.calls.length;
    await page.save({ ...FILLED, creator: "   " });
    expect(page.text("formnote")).toBe("Creator is required.");
    await page.save({ ...FILLED, logged_by: "" });
    expect(page.text("formnote")).toContain("Logged by is required");
    await page.save({ ...FILLED, quantity: "0" });
    expect(page.text("formnote")).toContain("Quantity must be a whole number");
    expect(page.calls.length).toBe(before);
  });

  test("a refusal from the server is shown in the server's own words, and nothing is added", async () => {
    const page = await loadPage({ rows: ROWS, postFail: { status: 400, error: "Tracking must be an http or https address." } });
    await page.save(FILLED);
    expect(page.text("formnote")).toBe("Not saved: Tracking must be an http or https address.");
    expect(page.creators()).toHaveLength(4);
    expect((page.el("creator") as any).value).toBe("Board Game Barrage");
  });

  test("a 503 because the key is missing is shown too", async () => {
    const page = await loadPage({ rows: ROWS, postFail: { status: 503, error: "Logging from the portal is not switched on yet: the Notion key is missing. Log it in Notion instead." } });
    await page.save(FILLED);
    expect(page.text("formnote")).toContain("the Notion key is missing");
  });
});

describe("without the Notion key, the page says so and points at Notion", () => {
  test("a plain notice with the link, the form shut, no counters", async () => {
    const page = await loadPage({ configured: false });
    expect(page.text("notice")).toContain("Logging from here opens as soon as the Notion key is in place");
    expect(page.text("notice")).toContain("Until then, log in Notion");
    expect(page.noticeLinks()).toEqual([NOTION_URL]);
    expect(page.fieldsShut()).toBe(true);
    expect(page.overviewHidden()).toBe(true);
    expect(page.text("list")).toContain("once the key is in place");
    expect(page.errors).toEqual([]);
  });

  test("a submit while shut sends nothing", async () => {
    const page = await loadPage({ configured: false });
    await page.save(FILLED);
    expect(page.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(page.text("formnote")).toContain("closed");
  });
});

describe("when Notion or the server cannot be reached, the page says so instead of going blank", () => {
  test("Notion's status and hint are shown, with the Notion link, the form shut", async () => {
    const page = await loadPage({ fail: 502, error: "Notion answered 404 (the database is probably not shared with the integration: open it in Notion, the ... menu top right, Connections)." });
    const shown = page.text("notice");
    expect(shown).toContain("could not be fetched");
    expect(shown).toContain("Notion answered 404");
    expect(shown).toContain("not shared with the integration");
    expect(shown).toContain("Log in Notion meanwhile");
    expect(shown).toContain("Reload the page");
    expect(page.noticeLinks()).toEqual([NOTION_URL, "/shipments"]);
    expect(page.fieldsShut()).toBe(true);
    expect(page.overviewHidden()).toBe(true);
    expect(page.errors.length).toBeGreaterThan(0);
  });

  test("every status leaves something on screen", async () => {
    for (const fail of [500, 502, 503] as const) {
      const page = await loadPage({ fail });
      expect(page.text("notice")).toContain(String(fail));
      expect(page.noticeLinks()[0]).toBe(NOTION_URL);
    }
  });

  test("no reply at all is shown too, and logged", async () => {
    const page = await loadPage({ fail: "throw" });
    expect(page.text("notice")).toContain("No contact with the server");
    expect(page.noticeLinks()[0]).toBe(NOTION_URL);
    expect(page.fieldsShut()).toBe(true);
    expect(page.errors.length).toBeGreaterThan(0);
  });
});

describe("it looks like the portal, and every portal page can reach it", () => {
  test("the portal's palette, and none of the post-it colours Lucas rejected", () => {
    for (const banned of ["#fef3c7", "#fef9c3", "#fde68a", "#fffbeb", "#fef08a", "#fde047"]) {
      expect(HTML.toLowerCase()).not.toContain(banned);
    }
    for (const wanted of ["#f2ede4", "#171717", "#c96a3d", "Asul", "Inter"]) {
      expect(HTML).toContain(wanted);
    }
  });

  test("mobile first: the phone layout is the base and one min-width query widens it", () => {
    expect(HTML).toContain("@media(min-width:680px)");
    expect(HTML).not.toContain("@media(max-width");
    // Fields at 16px, so a phone does not zoom in on tap.
    expect(HTML).toMatch(/\.field input,\.field select,\.field textarea\{[^}]*font-size:16px/);
  });

  test("the Shipments tab is on every page of the portal", () => {
    for (const page of ["index", "dashboard", "inventory", "growth", "ideas", "assets", "shipments"]) {
      const html = readFileSync(join(REPO, "public", `${page}.html`), "utf8");
      expect(html).toContain('href="/shipments"');
    }
  });

  test("the page says it in English", () => {
    for (const word of ["Creator shipments", "Log a shipment", "Every shipment", "Save to Notion", "Logged by"]) {
      expect(HTML).toContain(word);
    }
  });
});
