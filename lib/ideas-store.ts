// The marketing ideas store: the only code that touches the ideas file.
//
//   data/ideas.json          the committed seed. Read only in the container.
//   STATE_DIR/ideas.json     what people typed in the browser. The persistent volume.
//
// The merge direction is the whole point of this file, and it is the OPPOSITE of
// readTasks() in server.ts. Tasks only ever come from the seed, so that reader can
// rebuild its list from the seed on every read and keep just the done flag. Ideas are
// created by people in the browser, so a seed-driven rebuild would delete every idea
// anyone had written the moment we deployed. Here the stored file wins: every stored
// idea is kept, and a seed idea is added only when its id is not already stored.
//
// Reading never writes. The stored file holds only the ideas that were created in the
// browser, and the seed is merged in fresh on each read. That means a typo fixed in
// data/ideas.json shows up on the next deploy instead of being frozen into the volume
// by whichever read happened to run first.

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { STATE_DIR } from "./state-dir.ts";

export const IDEAS_FILE = join(STATE_DIR, "ideas.json");
export const IDEAS_SEED = join(import.meta.dir, "..", "data", "ideas.json");

// What one idea, and the whole store, may grow to.
//
// Without these, one POST could store just under the server's 1 MB body ceiling, and
// nothing capped how many rows the file grew to. Every append rewrites the entire file
// synchronously, so an unbounded store is not only a full volume: it is a write that
// blocks the event loop for every other request on the way there.
//
// An idea is a hook and a short paragraph about what it shows, so these are roomy for
// what people actually type and far below what the endpoint used to take.
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 4000;
export const MAX_CREATED_BY_CHARS = 100;
/** How many browser-created ideas the file holds. Seeded ideas live in the seed, not here. */
export const MAX_IDEAS = 2000;
/** A backstop under the row count, for rows that are each near the field limits. */
export const MAX_STORE_BYTES = 2 * 1024 * 1024;

export type Brand = { id: string; label: string };

export type Idea = {
  id: string;
  brand: string;
  title: string;
  body: string;
  created_at: string;
  created_by: string;
  /** The numbered hook template a seeded idea was built from. Absent on new ideas. */
  template?: number;
};

export type NewIdea = {
  brand?: unknown;
  title?: unknown;
  body?: unknown;
  created_by?: unknown;
};

/**
 * A refusal carries the status the API should answer with, so the rule and its status
 * code are decided in one place instead of the route guessing from the message.
 * 400 means the input was malformed; 413 means it, or the store, was too big.
 */
export type AddRefusal = { ok: false; error: string; status: 400 | 413 };
export type AddResult = { ok: true; idea: Idea } | AddRefusal;

type SeedFile = { brands: Brand[]; ideas: Idea[] };

function readSeed(): SeedFile {
  if (!existsSync(IDEAS_SEED)) {
    // The seed is committed, so this only happens on a broken deploy. Not fatal, since
    // everything a person wrote still reads back from the volume, but nobody can add an
    // idea without a brand list, so it must not pass unseen.
    console.error(`[ideas] no seed at ${IDEAS_SEED}: no brands and no seeded ideas.`);
    return { brands: [], ideas: [] };
  }

  // A seed that exists but will not parse is a deploy bug, and treating it as empty
  // would quietly drop the brand list and the six seeded ideas. Fail loudly instead.
  const parsed = JSON.parse(readFileSync(IDEAS_SEED, "utf8"));
  return {
    brands: Array.isArray(parsed.brands) ? parsed.brands : [],
    ideas: Array.isArray(parsed.ideas) ? parsed.ideas : [],
  };
}

/**
 * The ideas written in the browser, in the order they were created.
 *
 * A missing file means nobody has added one yet. A file that IS there but is not
 * exactly the shape this store writes throws, and deliberately.
 *
 * Unparseable bytes are the obvious case. The dangerous one is a file that parses
 * perfectly and is still the wrong shape, such as {"ideas":{"legacy":{...}}} or a bare
 * array: reading `.ideas` off it yields something that is not an array. Answering that
 * with an empty list would hand the next append a blank slate to write over, so one
 * file somebody hand-edited, or a row shape from some future version, would be
 * overwritten by the next idea anybody typed. Refusing to read it keeps the bytes on
 * disk where a person can look at them.
 */
function readStored(): Idea[] {
  if (!existsSync(IDEAS_FILE)) return [];

  const parsed = JSON.parse(readFileSync(IDEAS_FILE, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${IDEAS_FILE} is valid JSON but not an object, so it is not this store's file. Refusing to read it, and nothing will be written over it.`);
  }

  const ideas = (parsed as { ideas?: unknown }).ideas;
  if (!Array.isArray(ideas)) {
    throw new Error(`${IDEAS_FILE} has no "ideas" array, so it is not this store's file. Refusing to read it, and nothing will be written over it.`);
  }

  // Every row, not just the container. A file holding [null] parses, and has an ideas
  // array, and still cannot be read back: anything that reaches for row.id throws. The
  // container check alone let a reader fail while a writer carried on appending to it,
  // which is the worst of the three outcomes, so a bad row is refused exactly like a bad
  // container. Reading is where this belongs: every path in and out goes through here.
  ideas.forEach((row, n) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${IDEAS_FILE} row ${n} is not an object, so this file cannot be read back. Refusing to read it, and nothing will be written over it.`);
    }
    for (const field of ["id", "brand", "title", "body", "created_at", "created_by"] as const) {
      if (typeof (row as Record<string, unknown>)[field] !== "string") {
        throw new Error(`${IDEAS_FILE} row ${n} has no string "${field}", so this file cannot be read back. Refusing to read it, and nothing will be written over it.`);
      }
    }
  });

  return ideas as Idea[];
}

/** The exact bytes the stored file holds for a given list. */
function serialise(ideas: Idea[]): string {
  return JSON.stringify({ ideas }, null, 2);
}

/**
 * Write the stored ideas as one file, via a temp file and a rename, so a crash halfway
 * through cannot leave a truncated ideas.json behind. Only browser-created ideas go in
 * here: seeded ones are merged in on read.
 */
function writeStored(json: string): void {
  const tmp = `${IDEAS_FILE}.tmp`;
  writeFileSync(tmp, json);
  renameSync(tmp, IDEAS_FILE);
}

/**
 * The brands the page can show, in seed order.
 *
 * Brands are data, not code: adding a third one is an entry in data/ideas.json and
 * nothing else. Any brand that turns up on a stored idea but is no longer in the seed
 * is appended here as well, labelled with its own id, so removing a brand from the seed
 * can never make somebody's ideas invisible with no trace.
 */
export function readBrands(): Brand[] {
  const seed = readSeed();
  const brands = seed.brands.filter((b) => b && typeof b.id === "string" && b.id);
  const known = new Set(brands.map((b) => b.id));

  const orphans = new Set<string>();
  for (const idea of readStored()) {
    if (typeof idea?.brand === "string" && idea.brand && !known.has(idea.brand)) orphans.add(idea.brand);
  }
  for (const id of orphans) {
    console.error(`[ideas] stored ideas use brand "${id}", which is not in the seed. Showing it unlabelled.`);
    brands.push({ id, label: id });
  }

  return brands;
}

/**
 * Every idea: what people wrote, plus the seeded ones they have not replaced.
 *
 * Stored first, then the seed entries whose id is not already stored. Matching on id is
 * what keeps a redeploy from duplicating the six seeded ideas.
 */
export function readIdeas(): Idea[] {
  const stored = readStored();
  const storedIds = new Set(stored.map((i) => i.id));
  const fromSeed = readSeed().ideas.filter((i) => !storedIds.has(i.id));
  return [...stored, ...fromSeed];
}

/**
 * Add one idea, or say why it was refused. Nothing is written unless the input is good:
 * an unknown brand in particular must leave the file exactly as it was.
 */
export function addIdea(input: NewIdea): AddResult {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

  const brand = text(input.brand);
  const title = text(input.title);
  const body = text(input.body);
  // One shared password, so there is no signed-in identity to read here. The API can
  // name a writer; the browser form does not, and those rows say "portal".
  const created_by = text(input.created_by) || "portal";

  // These strings are the API's, not the page's, so they stay in English like the rest
  // of the code. The page writes its own Swedish sentence around them.
  if (!brand) return { ok: false, status: 400, error: "brand is required" };
  if (!readBrands().some((b) => b.id === brand)) return { ok: false, status: 400, error: `unknown brand: ${brand}` };
  if (!title) return { ok: false, status: 400, error: "title is required" };
  if (!body) return { ok: false, status: 400, error: "body is required" };

  // Measured after the trim, so trailing whitespace can never be what pushes a field
  // over. Length is in UTF-16 code units, the number String.length reports, so an emoji
  // counts as two. That errs on the small side, which is the right direction for a cap.
  if (title.length > MAX_TITLE_CHARS)
    return { ok: false, status: 413, error: `title is ${title.length} characters, the limit is ${MAX_TITLE_CHARS}` };
  if (body.length > MAX_BODY_CHARS)
    return { ok: false, status: 413, error: `body is ${body.length} characters, the limit is ${MAX_BODY_CHARS}` };
  if (created_by.length > MAX_CREATED_BY_CHARS)
    return {
      ok: false,
      status: 413,
      error: `created_by is ${created_by.length} characters, the limit is ${MAX_CREATED_BY_CHARS}`,
    };

  // Read the stored list again right here rather than reusing an earlier read, so the
  // window between reading and writing is as short as it can be.
  const stored = readStored();
  if (stored.length >= MAX_IDEAS) {
    console.error(`[ideas] refused an idea: the store holds ${stored.length} and the limit is ${MAX_IDEAS}.`);
    return { ok: false, status: 413, error: `the store is full: it holds ${MAX_IDEAS} ideas, which is the limit` };
  }

  const idea: Idea = {
    id: randomUUID(),
    brand,
    title,
    body,
    created_at: new Date().toISOString(),
    created_by,
  };

  // The row count is the limit people will meet. This is the backstop under it, for a
  // store whose rows are each near the field limits, and it is checked on the exact
  // bytes that are about to be written rather than on an estimate.
  const json = serialise([...stored, idea]);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_STORE_BYTES) {
    console.error(`[ideas] refused an idea: the store would reach ${bytes} bytes and the limit is ${MAX_STORE_BYTES}.`);
    return {
      ok: false,
      status: 413,
      error: `the store is full: it would reach ${bytes} bytes, the limit is ${MAX_STORE_BYTES}`,
    };
  }

  writeStored(json);
  console.log(`[ideas] added ${idea.id} brand=${idea.brand} by=${idea.created_by}`);
  return { ok: true, idea };
}
