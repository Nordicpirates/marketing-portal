// Creator shipments: the only code that talks to the Notion database.
//
// Which games went to which content creator, when, and what came back, lives in the
// Notion database "Creator Shipments" (built 2026-09-14, under Marketing HQ in the
// Nordic Pirates business hub). The team writes it in Notion directly or from the
// portal's /shipments page, and this file is how the portal reads and writes it.
//
// Two environment variables:
//   NOTION_PORTAL_TOKEN   the secret of the internal Notion integration the database is
//                         shared with. Unset means not configured: reads say so and
//                         point at Notion, writes are refused, and nothing throws.
//   NOTION_SHIPMENTS_DB   the database id. Defaults to the one built on 2026-09-14.
//
// Everything that shapes data is a pure function (validateInput, toNotionProperties,
// toRow), so it is tested without a network. The two functions that do talk to Notion
// take their fetch, token and clock as arguments for the same reason.

export const NOTION_API = (process.env.NOTION_API_BASE || "https://api.notion.com/v1").replace(/\/$/, "");
export const NOTION_VERSION = "2022-06-28";
export const DEFAULT_DB = "e13c793a-1167-42dc-a45f-3264a145b808";
export const NOTION_URL = "https://app.notion.com/p/e13c793a116742dca45f3264a145b808";

// The select options exactly as the database has them. A new option is added in
// Notion first, then here, or Notion refuses the row with a 400.
export const GAMES = [
  "Lying Pirates - Big Box",
  "Lying Pirates - Base Game",
  "Cities of Greed",
  "Kraken Mini",
  "TAP 10: Inventions",
  "Accessories",
  "Other",
] as const;
export const SHIPPED_FROM = ["Stockholm office", "US warehouse", "UK warehouse", "EU warehouse", "AU warehouse", "Other"] as const;
export const PLATFORMS = ["YouTube", "Instagram", "TikTok", "Blog", "Podcast", "Other"] as const;
export const STATUSES = ["Planned", "Sent", "Delivered", "Content published", "No content"] as const;

export const MAX_CREATOR_CHARS = 120;
export const MAX_LOGGED_BY_CHARS = 60;
export const MAX_NOTES_CHARS = 2000;
export const MAX_URL_CHARS = 2000;
export const MAX_EMAIL_CHARS = 254;
export const MAX_QUANTITY = 500;
/** How long a list read is reused before Notion is asked again. */
export const CACHE_MS = 30_000;
/** Notion's own ceiling per query page. */
export const PAGE_SIZE = 100;
/** A backstop on pagination: 50 pages of 100 is far past anything this list will hold. */
const MAX_PAGES = 50;

/** One row as the page shows it. Blank strings and nulls, never undefined. */
export type Shipment = {
  id: string;
  url: string;
  creator: string;
  game: string;
  quantity: number | null;
  /** YYYY-MM-DD, or null when the row has no date. */
  sent: string | null;
  status: string;
  shipped_from: string;
  platform: string;
  contact_email: string;
  tracking: string;
  content_link: string;
  paid_usd: number | null;
  notes: string;
  logged_by: string;
  created: string;
};

/** What a validated form post turns into. Optional fields are empty strings. */
export type CleanShipment = {
  creator: string;
  game: string;
  quantity: number;
  sent: string;
  shipped_from: string;
  platform: string;
  contact_email: string;
  tracking: string;
  notes: string;
  logged_by: string;
};

export type Validation = { ok: true; value: CleanShipment } | { ok: false; error: string };

const no = (error: string): Validation => ({ ok: false, error });

/** The value as text, trimmed. An object or an array is not text and comes back as null. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return null;
}

/** A calendar date written YYYY-MM-DD that really exists: 2026-02-30 is refused. */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isHttpUrl(value: string): boolean {
  if (value.length > MAX_URL_CHARS) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_CHARS && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Check one posted shipment and hand back either the cleaned values or one plain
 * sentence saying what is wrong. Nothing is sent to Notion unless this says ok.
 *
 * The sentences are what the page shows next to the save button, so they name the
 * field the way the form labels it and say what would be accepted.
 */
export function validateInput(input: unknown): Validation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return no("The body must be a JSON object.");
  const raw = input as Record<string, unknown>;

  const creator = text(raw.creator);
  if (creator === null) return no("Creator must be text.");
  if (!creator) return no("Creator is required.");
  if (creator.length > MAX_CREATOR_CHARS) return no(`Creator is ${creator.length} characters, the limit is ${MAX_CREATOR_CHARS}.`);

  const game = text(raw.game) ?? "";
  if (!(GAMES as readonly string[]).includes(game)) return no(`Game must be one of: ${GAMES.join(", ")}.`);

  // Quantity arrives as a number from the page and may arrive as "3" from anything
  // else. Missing means one parcel with one game in it.
  let quantity = 1;
  const q = raw.quantity;
  if (q !== undefined && q !== null && !(typeof q === "string" && q.trim() === "")) {
    const n = typeof q === "number" ? q : typeof q === "string" ? Number(q.trim()) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) return no(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    quantity = n;
  }

  const sent = text(raw.sent) ?? "";
  if (!isRealDate(sent)) return no("Sent must be a real date, written YYYY-MM-DD.");

  const shipped_from = text(raw.shipped_from) ?? "";
  if (shipped_from && !(SHIPPED_FROM as readonly string[]).includes(shipped_from)) return no(`Shipped from must be one of: ${SHIPPED_FROM.join(", ")}.`);

  const platform = text(raw.platform) ?? "";
  if (platform && !(PLATFORMS as readonly string[]).includes(platform)) return no(`Platform must be one of: ${PLATFORMS.join(", ")}.`);

  const contact_email = text(raw.contact_email) ?? "";
  if (contact_email && !looksLikeEmail(contact_email)) return no("Contact email does not look like an email address.");

  const tracking = text(raw.tracking) ?? "";
  if (tracking && !isHttpUrl(tracking)) return no("Tracking must be an http or https address.");

  const notes = text(raw.notes);
  if (notes === null) return no("Notes must be text.");
  if (notes.length > MAX_NOTES_CHARS) return no(`Notes is ${notes.length} characters, the limit is ${MAX_NOTES_CHARS}.`);

  const logged_by = text(raw.logged_by);
  if (logged_by === null) return no("Logged by must be text.");
  if (!logged_by) return no("Logged by is required: write your name.");
  if (logged_by.length > MAX_LOGGED_BY_CHARS) return no(`Logged by is ${logged_by.length} characters, the limit is ${MAX_LOGGED_BY_CHARS}.`);

  return { ok: true, value: { creator, game, quantity, sent, shipped_from, platform, contact_email, tracking, notes, logged_by } };
}

/**
 * The properties object Notion's create-page call wants for one cleaned shipment.
 * Optional fields that are empty are left out rather than sent as blanks, and every
 * row logged from the portal starts as Status "Sent": the form is for parcels that
 * have gone.
 */
export function toNotionProperties(value: CleanShipment): Record<string, unknown> {
  const rich = (content: string) => ({ rich_text: [{ type: "text", text: { content } }] });
  const props: Record<string, unknown> = {
    Creator: { title: [{ type: "text", text: { content: value.creator } }] },
    Game: { select: { name: value.game } },
    Quantity: { number: value.quantity },
    Sent: { date: { start: value.sent } },
    Status: { select: { name: "Sent" } },
    "Logged by": rich(value.logged_by),
  };
  if (value.shipped_from) props["Shipped from"] = { select: { name: value.shipped_from } };
  if (value.platform) props.Platform = { select: { name: value.platform } };
  if (value.contact_email) props["Contact email"] = { email: value.contact_email };
  if (value.tracking) props.Tracking = { url: value.tracking };
  if (value.notes) props.Notes = rich(value.notes);
  return props;
}

/**
 * One Notion page object, as the query and create calls return it, read into a row.
 *
 * Lenient on purpose: a property that is missing or has an unexpected shape reads as
 * blank, so one odd row in Notion can never blank the whole list. The page id and url
 * come from the page itself; Created falls back to the page's own created_time.
 */
export function toRow(page: unknown): Shipment {
  const p = page && typeof page === "object" ? (page as Record<string, any>) : {};
  const props: Record<string, any> = p.properties && typeof p.properties === "object" ? p.properties : {};

  const rich = (name: string): string => {
    const parts = props[name]?.title ?? props[name]?.rich_text;
    if (!Array.isArray(parts)) return "";
    return parts
      .map((t: any) => (typeof t?.plain_text === "string" ? t.plain_text : typeof t?.text?.content === "string" ? t.text.content : ""))
      .join("");
  };
  const select = (name: string): string => {
    const s = props[name]?.select;
    return s && typeof s.name === "string" ? s.name : "";
  };
  const number = (name: string): number | null => {
    const n = props[name]?.number;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  const date = (name: string): string | null => {
    const d = props[name]?.date;
    return d && typeof d.start === "string" && d.start ? d.start.slice(0, 10) : null;
  };
  const str = (name: string, key: string): string => {
    const v = props[name]?.[key];
    return typeof v === "string" ? v : "";
  };

  return {
    id: typeof p.id === "string" ? p.id : "",
    url: typeof p.url === "string" ? p.url : "",
    creator: rich("Creator"),
    game: select("Game"),
    quantity: number("Quantity"),
    sent: date("Sent"),
    status: select("Status"),
    shipped_from: select("Shipped from"),
    platform: select("Platform"),
    contact_email: str("Contact email", "email"),
    tracking: str("Tracking", "url"),
    content_link: str("Content link", "url"),
    paid_usd: number("Paid (USD)"),
    notes: rich("Notes"),
    logged_by: rich("Logged by"),
    created: str("Created", "created_time") || (typeof p.created_time === "string" ? p.created_time : ""),
  };
}

/**
 * Notion said no, or could not be reached. `status` is Notion's HTTP status, or 0 when
 * there was no answer at all. The message is one sentence a person can act on; Notion's
 * own body is not carried, because it can echo the request back.
 */
export class NotionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "NotionError";
  }
}

function hint(status: number): string {
  if (status === 401) return " (the integration key was refused)";
  if (status === 403 || status === 404) return " (the database is probably not shared with the integration: open it in Notion, the ... menu top right, Connections)";
  if (status === 429) return " (too many requests, try again in a minute)";
  if (status >= 500) return " (Notion is having trouble)";
  return "";
}

export type NotionOptions = {
  fetch?: typeof fetch;
  token?: string;
  db?: string;
  now?: () => number;
};

function settings(opts: NotionOptions) {
  return {
    fetch: opts.fetch ?? globalThis.fetch,
    token: (opts.token ?? process.env.NOTION_PORTAL_TOKEN ?? "").trim(),
    db: (opts.db ?? process.env.NOTION_SHIPMENTS_DB ?? "").trim() || DEFAULT_DB,
    now: opts.now ?? Date.now,
  };
}

/** True when there is a key to talk to Notion with. */
export function isConfigured(opts: NotionOptions = {}): boolean {
  return settings(opts).token.length > 0;
}

async function notion(s: ReturnType<typeof settings>, path: string, body: unknown): Promise<any> {
  if (!s.token) throw new NotionError(0, "The Notion key is not configured.");
  let res: Response;
  try {
    res = await s.fetch(`${NOTION_API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${s.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NotionError(0, "No contact with Notion.");
  }
  if (!res.ok) throw new NotionError(res.status, `Notion answered ${res.status}${hint(res.status)}.`);
  try {
    return await res.json();
  } catch {
    throw new NotionError(res.status, "Notion's answer could not be read.");
  }
}

let cache: { at: number; rows: Shipment[] } | null = null;

/** Forget the last list read, so the next read asks Notion again. */
export function clearCache(): void {
  cache = null;
}

/**
 * Every row, newest Sent first, following Notion's cursor to the end of the list.
 * Reused for CACHE_MS so a page reload does not cost a Notion round trip each time.
 */
export async function listShipments(opts: NotionOptions = {}): Promise<Shipment[]> {
  const s = settings(opts);
  if (cache && s.now() - cache.at < CACHE_MS) return cache.rows;

  const rows: Shipment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      sorts: [{ property: "Sent", direction: "descending" }],
      page_size: PAGE_SIZE,
    };
    if (cursor) body.start_cursor = cursor;
    const data = await notion(s, `/databases/${s.db}/query`, body);
    for (const item of Array.isArray(data?.results) ? data.results : []) rows.push(toRow(item));
    if (!data?.has_more || typeof data.next_cursor !== "string" || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  cache = { at: s.now(), rows };
  return rows;
}

/** Create one row in Notion from cleaned input, and forget the cached list. */
export async function addShipment(value: CleanShipment, opts: NotionOptions = {}): Promise<Shipment> {
  const s = settings(opts);
  const page = await notion(s, "/pages", { parent: { database_id: s.db }, properties: toNotionProperties(value) });
  cache = null;
  return toRow(page);
}
