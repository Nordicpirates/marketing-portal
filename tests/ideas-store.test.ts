// The ideas store, straight off the acceptance criteria in issue #20.
//
// The load-bearing one is the merge direction. readTasks() in server.ts rebuilds its
// list from the committed seed on every read, which silently drops any row the seed does
// not have. Ideas are typed by people in the browser, so the same shape would delete
// their work on the next deploy. Everything under "reading merges the stored file over
// the seed" is there to catch that if anyone ever changes it back.
//
// About the store file: bun test shares one module cache across test files, so the first
// file to import lib/state-dir.ts fixes STATE_DIR for the whole run. This file therefore
// does not assume it owns a fresh directory: it asks the store module where its file is,
// saves whatever is in there, drives each test from a known file it writes itself, and
// puts the original back at the end.
//
// The store keeps no state in memory. Every function reads the files again, so calling
// readIdeas() after a write is exactly what a freshly started process sees on the same
// volume. tests/ideas-api.test.ts does the redeploy for real, with a server it stops and
// starts again.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Only if no other test file got there first: overwriting it would send this file's
// writes to a directory the store is not reading.
if (!process.env.STATE_DIR) process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "ideas-store-test-"));

const REPO = join(import.meta.dir, "..");
const SEED = JSON.parse(readFileSync(join(REPO, "data", "ideas.json"), "utf8"));

type Idea = {
  id: string;
  brand: string;
  title: string;
  body: string;
  created_at: string;
  created_by: string;
  template?: number;
};

type Refusal = { ok: false; error: string; status: 400 | 413 };

let addIdea: (input: Record<string, unknown>) => { ok: true; idea: Idea } | Refusal;
let readIdeas: () => Idea[];
let readBrands: () => { id: string; label: string }[];
let IDEAS_FILE: string;
let MAX_TITLE_CHARS: number;
let MAX_BODY_CHARS: number;
let MAX_CREATED_BY_CHARS: number;
let MAX_IDEAS: number;
let MAX_STORE_BYTES: number;

let original: string | null = null;

beforeAll(async () => {
  const store = await import("../lib/ideas-store.ts");
  addIdea = store.addIdea;
  readIdeas = store.readIdeas;
  readBrands = store.readBrands;
  IDEAS_FILE = store.IDEAS_FILE;
  MAX_TITLE_CHARS = store.MAX_TITLE_CHARS;
  MAX_BODY_CHARS = store.MAX_BODY_CHARS;
  MAX_CREATED_BY_CHARS = store.MAX_CREATED_BY_CHARS;
  MAX_IDEAS = store.MAX_IDEAS;
  MAX_STORE_BYTES = store.MAX_STORE_BYTES;

  original = existsSync(IDEAS_FILE) ? readFileSync(IDEAS_FILE, "utf8") : null;
});

afterAll(() => {
  if (original === null) {
    if (existsSync(IDEAS_FILE)) unlinkSync(IDEAS_FILE);
  } else {
    writeFileSync(IDEAS_FILE, original);
  }
});

/** Put the stored file into a known state. `null` means the file is not there at all. */
function stored(ideas: Partial<Idea>[] | null) {
  if (ideas === null) {
    if (existsSync(IDEAS_FILE)) unlinkSync(IDEAS_FILE);
    return;
  }
  writeFileSync(IDEAS_FILE, JSON.stringify({ ideas }, null, 2));
}

function fileBytes(): string | null {
  return existsSync(IDEAS_FILE) ? readFileSync(IDEAS_FILE, "utf8") : null;
}

function ids(list: Idea[]): string[] {
  return list.map((i) => i.id);
}

function handmade(extra: Partial<Idea> = {}): Idea {
  return {
    id: "typed-in-the-browser-1",
    brand: "tap10",
    title: "A hook somebody typed on the portal",
    body: "Written in the browser, not in the seed. This row is the whole point of the merge.",
    created_at: "2026-08-31T09:12:00.000Z",
    created_by: "portal",
    ...extra,
  };
}

describe("the committed seed", () => {
  test("carries six ideas, three per brand, under the two brands it declares", () => {
    expect(SEED.ideas).toHaveLength(6);
    expect(SEED.brands.map((b: any) => b.id)).toEqual(["lying-pirates", "tap10"]);
    expect(SEED.ideas.filter((i: Idea) => i.brand === "lying-pirates")).toHaveLength(3);
    expect(SEED.ideas.filter((i: Idea) => i.brand === "tap10")).toHaveLength(3);
  });

  test("every seeded idea has the fields a record must have, and a unique id", () => {
    const known = new Set(SEED.brands.map((b: any) => b.id));
    for (const idea of SEED.ideas as Idea[]) {
      for (const field of ["id", "brand", "title", "body", "created_at", "created_by"] as const) {
        expect(typeof idea[field]).toBe("string");
        expect(idea[field]).not.toBe("");
      }
      expect(known.has(idea.brand)).toBe(true);
      expect(new Date(idea.created_at).toString()).not.toBe("Invalid Date");
    }
    expect(new Set(ids(SEED.ideas)).size).toBe(6);
  });
});

describe("reading merges the stored file over the seed", () => {
  test("with nothing stored yet, the page still gets all six seeded ideas", () => {
    stored(null);
    expect(ids(readIdeas()).sort()).toEqual(ids(SEED.ideas).sort());
  });

  test("reading never writes, so a read cannot rewrite anybody's file", () => {
    stored(null);
    readIdeas();
    readBrands();
    expect(existsSync(IDEAS_FILE)).toBe(false);
  });

  test("an idea typed in the browser survives a redeploy, and the seed is not duplicated", () => {
    stored(null);
    const added = addIdea({ brand: "tap10", title: "Two cards, three seconds", body: "Guess which is older." });
    expect(added.ok).toBe(true);

    // Same thing a freshly started process does: read the files again.
    const after = readIdeas();
    expect(after).toHaveLength(7);
    expect(after.some((i) => i.title === "Two cards, three seconds")).toBe(true);

    // Every seeded idea is there exactly once. This is what an id-keyed merge buys.
    for (const seeded of SEED.ideas as Idea[]) {
      expect(after.filter((i) => i.id === seeded.id)).toHaveLength(1);
    }
    // And doing it again does not grow the list.
    expect(readIdeas()).toHaveLength(7);
  });

  test("a stored idea the seed has never heard of is kept, not dropped", () => {
    // The readTasks() shape drops exactly this row. If this test fails, browser-created
    // ideas are being deleted on deploy.
    stored([handmade()]);
    const after = readIdeas();
    expect(after).toHaveLength(7);
    expect(after.find((i) => i.id === "typed-in-the-browser-1")).toEqual(handmade());
  });

  test("when an id is in both, the stored row wins and the seed one is not added again", () => {
    const edited = handmade({ id: "seed-tap10-1", title: "Edited on the volume" });
    stored([edited]);

    const after = readIdeas();
    expect(after.filter((i) => i.id === "seed-tap10-1")).toHaveLength(1);
    expect(after.find((i) => i.id === "seed-tap10-1")!.title).toBe("Edited on the volume");
    expect(after).toHaveLength(6);
  });

  test("a stored file that cannot be parsed throws instead of reading as empty", () => {
    // Reading it as an empty list would hand the next append a blank slate to write
    // over, turning one bad byte into the loss of every idea in the file.
    writeFileSync(IDEAS_FILE, "{ this is not json");
    expect(() => readIdeas()).toThrow();
    stored(null);
  });

  test("valid JSON of the wrong shape throws too, and adding leaves it byte for byte", () => {
    // The nastier case than unparseable bytes: the file parses perfectly, so a reader
    // that only asks "is .ideas an array?" answers "no" and hands back an empty list.
    // The next append then writes one row over whatever was in there. Every shape below
    // must refuse to read, and must survive an attempted add untouched.
    const wrong = [
      '{"ideas":{"legacy":{"title":"must survive"}}}',
      '{"ideas":"not an array"}',
      '{"ideas":null}',
      '{"notideas":[]}',
      "{}",
      "[]",
      '[{"id":"a-bare-array-of-ideas"}]',
      "null",
      '"a string"',
      "42",
    ];

    for (const bytes of wrong) {
      writeFileSync(IDEAS_FILE, bytes);
      expect(() => readIdeas()).toThrow();

      // Adding must not succeed either. It throws rather than refusing politely, which
      // is the point: the store will not carry on over a file it does not recognise.
      // The one thing that must never happen is a write.
      let added = false;
      try {
        added = addIdea({ brand: "tap10", title: "Should not land", body: "The file is the wrong shape." }).ok;
      } catch {
        added = false;
      }
      expect(added).toBe(false);
      expect(fileBytes()).toBe(bytes);
    }

    stored(null);
  });
});

describe("brands are data, not code", () => {
  test("the brand list comes from the seed, in seed order", () => {
    stored(null);
    expect(readBrands()).toEqual(SEED.brands);
  });

  test("a brand only the stored rows use still gets a tab, so no idea goes invisible", () => {
    stored([handmade({ id: "third-brand-row", brand: "some-third-brand" })]);
    const brands = readBrands();
    expect(brands.map((b) => b.id)).toEqual(["lying-pirates", "tap10", "some-third-brand"]);
    // Its ideas are readable too, they are just not filed under a seeded brand.
    expect(readIdeas().some((i) => i.brand === "some-third-brand")).toBe(true);
  });
});

describe("adding an idea", () => {
  test("stores it with an id, a timestamp and a writer", () => {
    stored(null);
    const before = Date.now();
    const result = addIdea({ brand: "lying-pirates", title: "  Is he lying?  ", body: "  Freeze the frame.  " });

    expect(result.ok).toBe(true);
    const idea = (result as { ok: true; idea: Idea }).idea;
    expect(idea.brand).toBe("lying-pirates");
    // Trimmed, so a stray space does not become part of the copy.
    expect(idea.title).toBe("Is he lying?");
    expect(idea.body).toBe("Freeze the frame.");
    expect(idea.id).not.toBe("");
    expect(idea.created_by).toBe("portal");
    expect(new Date(idea.created_at).getTime()).toBeGreaterThanOrEqual(before);

    // On disk, and readable back.
    expect(JSON.parse(fileBytes()!).ideas).toEqual([idea]);
    expect(readIdeas().find((i) => i.id === idea.id)).toEqual(idea);
  });

  test("two ideas added in a row both land, and get different ids", () => {
    stored(null);
    const one = addIdea({ brand: "tap10", title: "One", body: "First" }) as { ok: true; idea: Idea };
    const two = addIdea({ brand: "tap10", title: "Two", body: "Second" }) as { ok: true; idea: Idea };

    expect(one.idea.id).not.toBe(two.idea.id);
    expect(JSON.parse(fileBytes()!).ideas.map((i: Idea) => i.title)).toEqual(["One", "Two"]);
  });

  test("a writer can be named, and it is kept", () => {
    stored(null);
    const result = addIdea({ brand: "tap10", title: "T", body: "B", created_by: "bengt" }) as { ok: true; idea: Idea };
    expect(result.idea.created_by).toBe("bengt");
  });

  test("a missing or unknown brand is refused, and nothing at all is written", () => {
    for (const start of [null, [handmade()]] as (Partial<Idea>[] | null)[]) {
      stored(start);
      const before = fileBytes();

      for (const brand of [undefined, null, "", "   ", "nonsense", "Lying-Pirates", "lying pirates", 7, {}]) {
        const result = addIdea({ brand, title: "A title", body: "A body" });
        expect(result.ok).toBe(false);
        expect((result as { ok: false; error: string }).error).toContain("brand");
      }

      // Byte for byte what it was, including "no file at all".
      expect(fileBytes()).toBe(before);
    }
  });

  test("a blank title or body is refused, and nothing is written", () => {
    stored(null);
    for (const bad of [
      { brand: "tap10", body: "A body" },
      { brand: "tap10", title: "   ", body: "A body" },
      { brand: "tap10", title: 42, body: "A body" },
      { brand: "tap10", title: "A title" },
      { brand: "tap10", title: "A title", body: "  " },
      { brand: "tap10", title: "A title", body: null },
    ]) {
      const result = addIdea(bad);
      expect(result.ok).toBe(false);
    }
    expect(existsSync(IDEAS_FILE)).toBe(false);
  });
});

describe("limits, so one idea cannot fill the volume", () => {
  const ok = { brand: "tap10", title: "A title", body: "A body" };

  test("a title of exactly the limit lands, one character more is refused with 413", () => {
    stored(null);
    const atLimit = addIdea({ ...ok, title: "t".repeat(MAX_TITLE_CHARS) });
    expect(atLimit.ok).toBe(true);

    const before = fileBytes();
    const over = addIdea({ ...ok, title: "t".repeat(MAX_TITLE_CHARS + 1) }) as Refusal;
    expect(over.ok).toBe(false);
    expect(over.status).toBe(413);
    expect(over.error).toContain("title");
    expect(fileBytes()).toBe(before);
  });

  test("a body of exactly the limit lands, one character more is refused with 413", () => {
    stored(null);
    const atLimit = addIdea({ ...ok, body: "b".repeat(MAX_BODY_CHARS) });
    expect(atLimit.ok).toBe(true);

    const before = fileBytes();
    const over = addIdea({ ...ok, body: "b".repeat(MAX_BODY_CHARS + 1) }) as Refusal;
    expect(over.ok).toBe(false);
    expect(over.status).toBe(413);
    expect(over.error).toContain("body");
    expect(fileBytes()).toBe(before);
  });

  test("created_by is capped too, since the API lets a caller name the writer", () => {
    stored(null);
    expect(addIdea({ ...ok, created_by: "w".repeat(MAX_CREATED_BY_CHARS) }).ok).toBe(true);

    const before = fileBytes();
    const over = addIdea({ ...ok, created_by: "w".repeat(MAX_CREATED_BY_CHARS + 1) }) as Refusal;
    expect(over.ok).toBe(false);
    expect(over.status).toBe(413);
    expect(over.error).toContain("created_by");
    expect(fileBytes()).toBe(before);
  });

  test("the trim happens first, so trailing spaces never push a field over", () => {
    stored(null);
    const padded = addIdea({ ...ok, title: " ".repeat(50) + "t".repeat(MAX_TITLE_CHARS) + " ".repeat(50) });
    expect(padded.ok).toBe(true);
    expect((padded as { ok: true; idea: Idea }).idea.title).toHaveLength(MAX_TITLE_CHARS);
  });

  test("a nearly 1 MB field, which the body ceiling alone used to allow, is refused", () => {
    stored(null);
    const before = fileBytes();
    const huge = addIdea({ ...ok, body: "x".repeat(900_000) }) as Refusal;
    expect(huge.ok).toBe(false);
    expect(huge.status).toBe(413);
    expect(fileBytes()).toBe(before);
  });

  test("the store stops at MAX_IDEAS rows, and the refused add writes nothing", () => {
    const full = Array.from({ length: MAX_IDEAS }, (_, n) => handmade({ id: `row-${n}` }));
    stored(full);
    const before = fileBytes();

    const over = addIdea(ok) as Refusal;
    expect(over.ok).toBe(false);
    expect(over.status).toBe(413);
    expect(over.error).toContain("full");
    expect(fileBytes()).toBe(before);

    // One row under the limit still accepts, so the boundary is off-by-one clean.
    stored(full.slice(0, MAX_IDEAS - 1));
    expect(addIdea(ok).ok).toBe(true);
  });

  test("the byte quota refuses an append even when the row count is fine", () => {
    // Rows near the field limits, enough of them to pass the byte quota while staying
    // well under MAX_IDEAS, so it is provably the quota doing the refusing.
    const perRow = MAX_TITLE_CHARS + MAX_BODY_CHARS;
    const rows = Math.ceil(MAX_STORE_BYTES / perRow) + 20;
    expect(rows).toBeLessThan(MAX_IDEAS);

    stored(
      Array.from({ length: rows }, (_, n) =>
        handmade({ id: `big-${n}`, title: "t".repeat(MAX_TITLE_CHARS), body: "b".repeat(MAX_BODY_CHARS) })
      )
    );
    const before = fileBytes();
    expect(before!.length).toBeGreaterThan(MAX_STORE_BYTES);

    const over = addIdea(ok) as Refusal;
    expect(over.ok).toBe(false);
    expect(over.status).toBe(413);
    expect(fileBytes()).toBe(before);

    stored(null);
  });

  test("a refusal never reports 400 for something that was merely too big", () => {
    stored(null);
    const tooBig = addIdea({ ...ok, title: "t".repeat(MAX_TITLE_CHARS + 1) }) as Refusal;
    const malformed = addIdea({ ...ok, brand: "nonsense" }) as Refusal;
    expect(tooBig.status).toBe(413);
    expect(malformed.status).toBe(400);
  });
});

describe("the two brands stay apart", () => {
  test("an idea filed under one brand is never in the other brand's list", () => {
    stored(null);
    addIdea({ brand: "tap10", title: "Only for TAP 10", body: "Timeline card game." });
    addIdea({ brand: "lying-pirates", title: "Only for Lying Pirates", body: "Bluffing dice game." });

    const all = readIdeas();
    const lp = all.filter((i) => i.brand === "lying-pirates");
    const tap = all.filter((i) => i.brand === "tap10");

    expect(lp).toHaveLength(4);
    expect(tap).toHaveLength(4);
    expect(lp.some((i) => i.title === "Only for TAP 10")).toBe(false);
    expect(tap.some((i) => i.title === "Only for Lying Pirates")).toBe(false);
    // No idea is in both lists, and every idea is in one of them.
    expect(lp.length + tap.length).toBe(all.length);
  });
});
