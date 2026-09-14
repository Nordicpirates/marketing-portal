// The real /assets page, loaded into a DOM and driven the way a person drives it, the
// same way tests/ideas-page.test.ts drives the ideas page: the inline script is lifted
// out of the HTML and evaluated against the DOM, fetch and console this file controls.
//
// The default payload is the repo's own data/assets.json, so these tests read the same
// links a person looking at the deployed page reads.

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const HTML = readFileSync(join(REPO, "public", "assets.html"), "utf8");
const SEED = JSON.parse(readFileSync(join(REPO, "data", "assets.json"), "utf8"));

const LINKS: any[] = SEED.groups.flatMap((g: any) => g.links);

/** The page's own script, ready to evaluate, with its self-start call removed. */
function pageScript(): string {
  const tag = HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!tag) throw new Error("public/assets.html has no inline <script> any more, this harness is stale");
  const withStart = tag[1];
  const src = withStart.replace(/\nload\(\);\s*$/, "\n");
  if (src === withStart) throw new Error("the page no longer ends by calling load(), this harness is stale");
  return src;
}

type Failure = { fail: number | "throw" };

async function loadPage(data: any = SEED) {
  const window = new Window({
    url: "https://marketing.nordicpirate.com/assets",
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
    },
  });
  const document = window.document;
  document.write(HTML);

  const errors: string[] = [];
  const calls: string[] = [];
  const failure = (data as Failure).fail;

  const fetchStub = async (url: string) => {
    calls.push(url);
    if (url !== "/api/assets") throw new Error(`the page fetched ${url}, which this harness does not answer`);
    if (failure === "throw") throw new TypeError("Failed to fetch");
    if (typeof failure === "number") {
      return new Response(JSON.stringify({ error: "no" }), { status: failure, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
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
  const cards = () => [...document.querySelectorAll("a.link")];

  return {
    document,
    errors,
    calls,
    groups: () => [...document.querySelectorAll("section[data-group]")].map((s: any) => s.getAttribute("data-group")),
    titles: () => cards().map((a: any) => a.querySelector(".t").textContent),
    hrefs: () => cards().map((a: any) => a.getAttribute("href")),
    cards,
    text: (id: string) => el(id).textContent.replace(/\s+/g, " ").trim(),
    async type(needle: string) {
      const input = el("filter");
      input.value = needle;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle();
    },
  };
}

describe("the data itself", () => {
  test("every link has a title, a description, a known kind and an https address", () => {
    const kinds = ["folder", "sheet", "pdf", "notion", "site", "gap"];
    expect(LINKS.length).toBeGreaterThan(20);
    for (const l of LINKS) {
      expect(l.title.trim().length).toBeGreaterThan(2);
      expect(l.desc.trim().length).toBeGreaterThan(10);
      expect(kinds).toContain(l.kind);
      expect(l.url.startsWith("https://")).toBe(true);
    }
  });

  test("no address appears twice", () => {
    const urls = LINKS.map((l) => l.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("the copy library Lucas asked for on 14 September is in, with his exact link", () => {
    const urls = LINKS.map((l) => l.url);
    expect(urls).toContain(
      "https://docs.google.com/spreadsheets/d/1vQS0wNcNG7slyW2RLKBkbV2qDNru9lRU/edit?gid=63545549#gid=63545549"
    );
  });

  test("the things he named by name are all there", () => {
    const titles = LINKS.map((l) => l.title.toLowerCase());
    for (const wanted of ["media kit lying pirates", "media kit tap10", "brand book v2", "creator content library", "games sent to creators"]) {
      expect(titles.some((t) => t.includes(wanted))).toBe(true);
    }
  });

  test("the review stamp is a date", () => {
    expect(SEED.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("everything in the data is on the page, and nothing else", () => {
  test("one section per group, in the data's order", async () => {
    const page = await loadPage();
    expect(page.groups()).toEqual(SEED.groups.map((g: any) => g.id));
    expect(page.errors).toEqual([]);
  });

  test("every link, in order, going exactly where the data says, in a new tab", async () => {
    const page = await loadPage();
    expect(page.titles()).toEqual(LINKS.map((l) => l.title));
    expect(page.hrefs()).toEqual(LINKS.map((l) => l.url));
    for (const a of page.cards()) {
      expect((a as any).getAttribute("target")).toBe("_blank");
      expect((a as any).getAttribute("rel")).toBe("noopener");
    }
    expect(page.text("count")).toBe(`${LINKS.length} links`);
  });

  test("no link is written into the markup, only into the data", () => {
    for (const l of LINKS) {
      expect(HTML).not.toContain(l.url);
      expect(HTML).not.toContain(l.title);
    }
  });

  test("the gap card is marked as a gap, so nobody mistakes it for a tracker", async () => {
    const page = await loadPage();
    const gaps = page.cards().filter((a: any) => a.classList.contains("gap"));
    expect(gaps.length).toBe(LINKS.filter((l) => l.kind === "gap").length);
    expect(page.document.body.textContent).toContain("Not tracked yet");
  });

  test("a title with markup in it is shown, not run", async () => {
    const nasty = {
      ...SEED,
      groups: [
        {
          id: "nasty",
          label: "<b>bold</b>",
          links: [{ title: "<img src=x onerror=alert(1)>", desc: "<i>x</i>", url: "https://example.com/x", kind: "site" }],
        },
      ],
    };
    const page = await loadPage(nasty);
    expect(page.titles()).toEqual(["<img src=x onerror=alert(1)>"]);
    expect(page.document.getElementById("groups").querySelectorAll("img")).toHaveLength(0);
    expect(page.document.getElementById("groups").querySelectorAll("b")).toHaveLength(0);
  });
});

describe("the search box", () => {
  test("narrows on title, description or group name, whatever the case", async () => {
    const page = await loadPage();
    await page.type("COPY LIBRARY");
    expect(page.titles()).toEqual(["Copy Library"]);
    expect(page.text("count")).toBe(`1 of ${LINKS.length} links`);

    // A word only in a description.
    await page.type("Liezel");
    expect(page.titles()).toEqual(["Brand book v2"]);

    // A group name brings the whole group.
    await page.type("Polytopia");
    expect(page.groups()).toEqual(["polytopia"]);
  });

  test("clearing it brings everything back", async () => {
    const page = await loadPage();
    await page.type("logo");
    expect(page.titles().length).toBeLessThan(LINKS.length);
    await page.type("");
    expect(page.titles()).toEqual(LINKS.map((l) => l.title));
  });

  test("no match says so instead of leaving a blank page", async () => {
    const page = await loadPage();
    await page.type("zzz-nothing-has-this");
    expect(page.titles()).toEqual([]);
    expect(page.text("groups")).toContain("Nothing matches");
  });

  test("searching never asks the server again", async () => {
    const page = await loadPage();
    const before = page.calls.length;
    await page.type("brand");
    await page.type("");
    expect(page.calls.length).toBe(before);
  });
});

describe("when the list cannot be fetched, the page says so instead of going blank", () => {
  test("a status is shown with its number", async () => {
    for (const fail of [500, 502, 503] as const) {
      const page = await loadPage({ fail });
      expect(page.text("groups")).toContain("could not be fetched");
      expect(page.text("groups")).toContain(String(fail));
      expect(page.text("groups")).toContain("Reload the page");
    }
  });

  test("no reply at all is shown too, and logged", async () => {
    const page = await loadPage({ fail: "throw" });
    expect(page.text("groups")).toContain("No contact with the server");
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

  test("the Assets tab is on every page of the portal", () => {
    for (const page of ["index", "dashboard", "inventory", "growth", "ideas", "assets"]) {
      const html = readFileSync(join(REPO, "public", `${page}.html`), "utf8");
      expect(html).toContain('href="/assets"');
    }
  });

  test("the hub's quick links open the asset page and the copy library", () => {
    const hub = readFileSync(join(REPO, "public", "index.html"), "utf8");
    expect(hub).toContain('href="/assets"');
    expect(hub).toContain("1vQS0wNcNG7slyW2RLKBkbV2qDNru9lRU");
  });
});
