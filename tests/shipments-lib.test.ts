// lib/shipments.ts without a network: the three pure functions against a real-shaped
// Notion page, and the two Notion calls against a fetch this file controls.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  CACHE_MS,
  DEFAULT_DB,
  GAMES,
  MAX_CREATOR_CHARS,
  MAX_LOGGED_BY_CHARS,
  MAX_NOTES_CHARS,
  MAX_QUANTITY,
  NOTION_API,
  NOTION_VERSION,
  NotionError,
  PLATFORMS,
  SHIPPED_FROM,
  addShipment,
  clearCache,
  isConfigured,
  isRealDate,
  listShipments,
  toNotionProperties,
  toRow,
  validateInput,
} from "../lib/shipments.ts";

/** One page exactly as Notion's query endpoint returns it for this database. */
const PAGE = {
  object: "page",
  id: "2c1a6e88-645a-8100-9f3a-000000000001",
  created_time: "2026-09-14T10:03:00.000Z",
  last_edited_time: "2026-09-14T10:03:00.000Z",
  url: "https://www.notion.so/Quackalope-2c1a6e88645a81009f3a000000000001",
  properties: {
    Creator: { id: "title", type: "title", title: [{ type: "text", text: { content: "Quacka", link: null }, plain_text: "Quacka" }, { type: "text", text: { content: "lope" }, plain_text: "lope" }] },
    Game: { id: "YGRp", type: "select", select: { id: "91f8", name: "Cities of Greed", color: "brown" } },
    Quantity: { id: "Qty", type: "number", number: 1 },
    Sent: { id: "Snt", type: "date", date: { start: "2025-11-24", end: null, time_zone: null } },
    Status: { id: "ZFFc", type: "select", select: { id: "a10e", name: "Sent", color: "blue" } },
    "Shipped from": { id: "UkRC", type: "select", select: null },
    Platform: { id: "aEJ-", type: "select", select: { id: "e572", name: "YouTube", color: "red" } },
    "Contact email": { id: "Eml", type: "email", email: null },
    Tracking: { id: "Trk", type: "url", url: null },
    "Content link": { id: "Cnt", type: "url", url: "https://www.youtube.com/watch?v=abc" },
    "Paid (USD)": { id: "Paid", type: "number", number: 200 },
    Notes: { id: "Nts", type: "rich_text", rich_text: [{ type: "text", text: { content: "Wanted 200 USD" }, plain_text: "Wanted 200 USD" }] },
    "Logged by": { id: "Lgb", type: "rich_text", rich_text: [{ type: "text", text: { content: "Bengt" }, plain_text: "Bengt" }] },
    Created: { id: "Crt", type: "created_time", created_time: "2026-09-14T10:03:00.000Z" },
  },
};

const GOOD = {
  creator: "  Board Game Barrage ",
  game: "TAP 10: Inventions",
  quantity: 2,
  sent: "2026-09-14",
  shipped_from: "Stockholm office",
  platform: "YouTube",
  contact_email: "hello@bgb.example",
  tracking: "https://track.example/abc",
  notes: "Prototype copy for the Kickstarter preview",
  logged_by: "Lucas",
};

function ok(input: unknown) {
  const result = validateInput(input);
  if (!result.ok) throw new Error(`expected the input to be accepted, got: ${result.error}`);
  return result.value;
}

function refused(input: unknown): string {
  const result = validateInput(input);
  if (result.ok) throw new Error("expected the input to be refused, it was accepted");
  return result.error;
}

describe("toRow reads a Notion page into a row", () => {
  test("every column, with rich text joined and blanks for empty cells", () => {
    expect(toRow(PAGE)).toEqual({
      id: PAGE.id,
      url: PAGE.url,
      creator: "Quackalope",
      game: "Cities of Greed",
      quantity: 1,
      sent: "2025-11-24",
      status: "Sent",
      shipped_from: "",
      platform: "YouTube",
      contact_email: "",
      tracking: "",
      content_link: "https://www.youtube.com/watch?v=abc",
      paid_usd: 200,
      notes: "Wanted 200 USD",
      logged_by: "Bengt",
      created: "2026-09-14T10:03:00.000Z",
    });
  });

  test("a date with a time keeps only the day", () => {
    const page = { ...PAGE, properties: { ...PAGE.properties, Sent: { type: "date", date: { start: "2026-09-14T09:30:00.000+02:00", end: null } } } };
    expect(toRow(page).sent).toBe("2026-09-14");
  });

  test("a page with no properties at all is a blank row, not a throw", () => {
    expect(toRow({ id: "x" }).creator).toBe("");
    expect(toRow(null).sent).toBeNull();
    expect(toRow("nonsense").quantity).toBeNull();
    expect(toRow({ properties: { Creator: { title: "not an array" }, Quantity: { number: "7" }, Sent: { date: { start: 5 } } } })).toMatchObject({
      creator: "",
      quantity: null,
      sent: null,
    });
  });

  test("Created falls back to the page's own created_time", () => {
    const { Created, ...rest } = PAGE.properties;
    expect(toRow({ ...PAGE, properties: rest }).created).toBe(PAGE.created_time);
  });
});

describe("toNotionProperties writes what Notion's create call wants", () => {
  test("every filled field in its Notion shape, and Status starts as Sent", () => {
    const props = toNotionProperties(ok(GOOD));
    expect(props).toEqual({
      Creator: { title: [{ type: "text", text: { content: "Board Game Barrage" } }] },
      Game: { select: { name: "TAP 10: Inventions" } },
      Quantity: { number: 2 },
      Sent: { date: { start: "2026-09-14" } },
      Status: { select: { name: "Sent" } },
      "Logged by": { rich_text: [{ type: "text", text: { content: "Lucas" } }] },
      "Shipped from": { select: { name: "Stockholm office" } },
      Platform: { select: { name: "YouTube" } },
      "Contact email": { email: "hello@bgb.example" },
      Tracking: { url: "https://track.example/abc" },
      Notes: { rich_text: [{ type: "text", text: { content: "Prototype copy for the Kickstarter preview" } }] },
    });
  });

  test("an empty optional field is left out, never sent as a blank select or url", () => {
    const props = toNotionProperties(ok({ creator: "X", game: "Other", sent: "2026-01-01", logged_by: "Y" }));
    expect(Object.keys(props).sort()).toEqual(["Creator", "Game", "Logged by", "Quantity", "Sent", "Status"]);
    expect(props.Quantity).toEqual({ number: 1 });
  });

  test("what is written reads back as the same row", () => {
    const value = ok(GOOD);
    const row = toRow({ id: "new", url: "https://www.notion.so/new", properties: toNotionProperties(value) });
    expect(row).toMatchObject({
      creator: "Board Game Barrage",
      game: "TAP 10: Inventions",
      quantity: 2,
      sent: "2026-09-14",
      status: "Sent",
      shipped_from: "Stockholm office",
      platform: "YouTube",
      contact_email: "hello@bgb.example",
      tracking: "https://track.example/abc",
      notes: "Prototype copy for the Kickstarter preview",
      logged_by: "Lucas",
    });
  });
});

describe("validateInput", () => {
  test("good input comes back trimmed, with the quantity as a number", () => {
    expect(ok(GOOD)).toEqual({ ...GOOD, creator: "Board Game Barrage" });
    expect(ok({ ...GOOD, quantity: "3" }).quantity).toBe(3);
    expect(ok({ ...GOOD, quantity: undefined }).quantity).toBe(1);
    expect(ok({ ...GOOD, quantity: "" }).quantity).toBe(1);
  });

  test("only the four required fields are required", () => {
    expect(ok({ creator: "X", game: "Kraken Mini", sent: "2026-09-14", logged_by: "Y" })).toEqual({
      creator: "X",
      game: "Kraken Mini",
      quantity: 1,
      sent: "2026-09-14",
      shipped_from: "",
      platform: "",
      contact_email: "",
      tracking: "",
      notes: "",
      logged_by: "Y",
    });
  });

  test("not an object is refused", () => {
    for (const bad of [null, "text", 7, [1, 2], undefined]) {
      expect(refused(bad)).toBe("The body must be a JSON object.");
    }
  });

  test("creator: required, text, at most the limit", () => {
    expect(refused({ ...GOOD, creator: "   " })).toBe("Creator is required.");
    expect(refused({ ...GOOD, creator: undefined })).toBe("Creator is required.");
    expect(refused({ ...GOOD, creator: { name: "x" } })).toBe("Creator must be text.");
    expect(refused({ ...GOOD, creator: "x".repeat(MAX_CREATOR_CHARS + 1) })).toBe(`Creator is ${MAX_CREATOR_CHARS + 1} characters, the limit is ${MAX_CREATOR_CHARS}.`);
    expect(ok({ ...GOOD, creator: "x".repeat(MAX_CREATOR_CHARS) }).creator.length).toBe(MAX_CREATOR_CHARS);
  });

  test("game must be one of the database's options, spelled exactly", () => {
    for (const game of GAMES) expect(ok({ ...GOOD, game }).game).toBe(game);
    for (const bad of ["Lying Pirates", "cities of greed", "", undefined, 3]) {
      expect(refused({ ...GOOD, game: bad })).toStartWith("Game must be one of: Lying Pirates - Big Box");
    }
  });

  test("quantity is a whole number from 1 to the limit", () => {
    for (const bad of [0, -1, 1.5, "abc", MAX_QUANTITY + 1, "2.5", true, {}]) {
      expect(refused({ ...GOOD, quantity: bad })).toBe(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    }
    expect(ok({ ...GOOD, quantity: MAX_QUANTITY }).quantity).toBe(MAX_QUANTITY);
  });

  test("sent must be a real calendar date written YYYY-MM-DD", () => {
    for (const bad of ["2026-02-30", "2026-9-1", "14/09/2026", "yesterday", "", undefined, "2026-13-01", "2026-09-14T10:00"]) {
      expect(refused({ ...GOOD, sent: bad })).toBe("Sent must be a real date, written YYYY-MM-DD.");
    }
    expect(ok({ ...GOOD, sent: "2024-02-29" }).sent).toBe("2024-02-29");
    expect(isRealDate("2023-02-29")).toBe(false);
  });

  test("shipped from and platform are optional, but must be real options when given", () => {
    for (const s of SHIPPED_FROM) expect(ok({ ...GOOD, shipped_from: s }).shipped_from).toBe(s);
    for (const p of PLATFORMS) expect(ok({ ...GOOD, platform: p }).platform).toBe(p);
    expect(refused({ ...GOOD, shipped_from: "Mars" })).toStartWith("Shipped from must be one of: Stockholm office");
    expect(refused({ ...GOOD, platform: "Radio" })).toStartWith("Platform must be one of: YouTube");
    expect(ok({ ...GOOD, shipped_from: "", platform: undefined }).platform).toBe("");
  });

  test("contact email is optional, and must look like an address when given", () => {
    expect(refused({ ...GOOD, contact_email: "not-an-address" })).toBe("Contact email does not look like an email address.");
    expect(refused({ ...GOOD, contact_email: "a@b" })).toBe("Contact email does not look like an email address.");
    expect(refused({ ...GOOD, contact_email: "a@b c.com" })).toBe("Contact email does not look like an email address.");
    expect(ok({ ...GOOD, contact_email: " crew@nordicpirate.com " }).contact_email).toBe("crew@nordicpirate.com");
    expect(ok({ ...GOOD, contact_email: "" }).contact_email).toBe("");
  });

  test("tracking is optional, and only http or https when given", () => {
    for (const bad of ["ftp://x.example/1", "javascript:alert(1)", "www.dhl.com/track", "https://" + "x".repeat(2100)]) {
      expect(refused({ ...GOOD, tracking: bad })).toBe("Tracking must be an http or https address.");
    }
    expect(ok({ ...GOOD, tracking: "http://track.example/1" }).tracking).toBe("http://track.example/1");
  });

  test("notes are optional and capped", () => {
    expect(ok({ ...GOOD, notes: "" }).notes).toBe("");
    expect(ok({ ...GOOD, notes: "x".repeat(MAX_NOTES_CHARS) }).notes.length).toBe(MAX_NOTES_CHARS);
    expect(refused({ ...GOOD, notes: "x".repeat(MAX_NOTES_CHARS + 1) })).toBe(`Notes is ${MAX_NOTES_CHARS + 1} characters, the limit is ${MAX_NOTES_CHARS}.`);
    expect(refused({ ...GOOD, notes: ["a"] })).toBe("Notes must be text.");
  });

  test("logged by is required: a name, capped", () => {
    expect(refused({ ...GOOD, logged_by: "" })).toBe("Logged by is required: write your name.");
    expect(refused({ ...GOOD, logged_by: undefined })).toBe("Logged by is required: write your name.");
    expect(refused({ ...GOOD, logged_by: "x".repeat(MAX_LOGGED_BY_CHARS + 1) })).toBe(`Logged by is ${MAX_LOGGED_BY_CHARS + 1} characters, the limit is ${MAX_LOGGED_BY_CHARS}.`);
  });
});

/** A fetch that plays Notion: records every call, answers as told. */
function fakeNotion(plan: { query?: any[]; create?: any; status?: number; throws?: boolean } = {}) {
  const calls: { url: string; init: any; body: any }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (plan.throws) throw new TypeError("Failed to fetch");
    if (plan.status && plan.status >= 400) {
      return new Response(JSON.stringify({ object: "error", status: plan.status, message: "Could not find database" }), { status: plan.status, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/pages")) {
      return new Response(JSON.stringify(plan.create ?? { id: "created", url: "https://www.notion.so/created", properties: JSON.parse(init.body).properties }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const pages = plan.query ?? [{ results: [PAGE], has_more: false, next_cursor: null }];
    const cursor = JSON.parse(init.body).start_cursor;
    const n = cursor ? Number(cursor.replace("cursor-", "")) : 0;
    return new Response(JSON.stringify(pages[n]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchFn };
}

describe("the two Notion calls, against a fetch this file controls", () => {
  beforeEach(() => clearCache());

  test("isConfigured is whether there is a token", () => {
    expect(isConfigured({ token: "" })).toBe(false);
    expect(isConfigured({ token: "   " })).toBe(false);
    expect(isConfigured({ token: "secret_x" })).toBe(true);
  });

  test("listShipments queries the database sorted by Sent, with the key and version headers, and follows the cursor to the end", async () => {
    const second = { ...PAGE, id: "page-2", properties: { ...PAGE.properties, Creator: { type: "title", title: [{ plain_text: "Meeple University" }] } } };
    const notion = fakeNotion({
      query: [
        { results: [PAGE], has_more: true, next_cursor: "cursor-1" },
        { results: [second], has_more: false, next_cursor: null },
      ],
    });
    let clock = 1_000_000;
    const rows = await listShipments({ fetch: notion.fetch, token: "secret_x", db: "db-123", now: () => clock });

    expect(rows.map((r) => r.creator)).toEqual(["Quackalope", "Meeple University"]);
    expect(notion.calls).toHaveLength(2);
    expect(notion.calls[0].url).toBe(`${NOTION_API}/databases/db-123/query`);
    expect(notion.calls[0].init.method).toBe("POST");
    expect(notion.calls[0].init.headers).toEqual({
      Authorization: "Bearer secret_x",
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    });
    expect(notion.calls[0].body).toEqual({ sorts: [{ property: "Sent", direction: "descending" }], page_size: 100 });
    expect(notion.calls[1].body.start_cursor).toBe("cursor-1");

    // The second read inside the cache window costs nothing; after it, Notion is asked again.
    clock += CACHE_MS - 1;
    await listShipments({ fetch: notion.fetch, token: "secret_x", db: "db-123", now: () => clock });
    expect(notion.calls).toHaveLength(2);
    clock += 2;
    await listShipments({ fetch: notion.fetch, token: "secret_x", db: "db-123", now: () => clock });
    expect(notion.calls).toHaveLength(4);
  });

  test("the default database is the one built on 14 September 2026", async () => {
    const notion = fakeNotion();
    await listShipments({ fetch: notion.fetch, token: "secret_x" });
    expect(notion.calls[0].url).toBe(`${NOTION_API}/databases/${DEFAULT_DB}/query`);
  });

  test("addShipment creates a page under the database and forgets the cached list", async () => {
    const notion = fakeNotion();
    await listShipments({ fetch: notion.fetch, token: "secret_x", db: "db-123" });
    expect(notion.calls).toHaveLength(1);

    const row = await addShipment(ok(GOOD), { fetch: notion.fetch, token: "secret_x", db: "db-123" });
    expect(notion.calls[1].url).toBe(`${NOTION_API}/pages`);
    expect(notion.calls[1].body.parent).toEqual({ database_id: "db-123" });
    expect(notion.calls[1].body.properties).toEqual(toNotionProperties(ok(GOOD)));
    expect(row.creator).toBe("Board Game Barrage");
    expect(row.status).toBe("Sent");

    await listShipments({ fetch: notion.fetch, token: "secret_x", db: "db-123" });
    expect(notion.calls).toHaveLength(3);
  });

  test("a refusal from Notion is a NotionError carrying the status and a hint, never Notion's body", async () => {
    const notion = fakeNotion({ status: 404 });
    let caught: any = null;
    try {
      await listShipments({ fetch: notion.fetch, token: "secret_x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotionError);
    expect(caught.status).toBe(404);
    expect(caught.message).toContain("Notion answered 404");
    expect(caught.message).toContain("not shared with the integration");
    expect(caught.message).not.toContain("Could not find database");

    // A failed read is not cached: the next read asks again.
    expect(notion.calls).toHaveLength(1);
    await listShipments({ fetch: notion.fetch, token: "secret_x" }).catch(() => {});
    expect(notion.calls).toHaveLength(2);
  });

  test("no answer at all is a NotionError with status 0", async () => {
    const notion = fakeNotion({ throws: true });
    let caught: any = null;
    try {
      await addShipment(ok(GOOD), { fetch: notion.fetch, token: "secret_x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotionError);
    expect(caught.status).toBe(0);
    expect(caught.message).toBe("No contact with Notion.");
  });

  test("without a token nothing is fetched", async () => {
    const notion = fakeNotion();
    await expect(listShipments({ fetch: notion.fetch, token: "" })).rejects.toBeInstanceOf(NotionError);
    expect(notion.calls).toHaveLength(0);
  });
});
