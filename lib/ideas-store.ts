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

export type AddResult = { ok: true; idea: Idea } | { ok: false; error: string };

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
 * A missing file means nobody has added one yet. A file that IS there but cannot be
 * parsed throws, and deliberately: reading it as an empty list would hand the next
 * append a blank slate to write over, which turns one unreadable byte into the loss of
 * every idea in the file.
 */
function readStored(): Idea[] {
  if (!existsSync(IDEAS_FILE)) return [];
  const parsed = JSON.parse(readFileSync(IDEAS_FILE, "utf8"));
  return Array.isArray(parsed.ideas) ? parsed.ideas : [];
}

/**
 * Write the stored ideas as one file, via a temp file and a rename, so a crash halfway
 * through cannot leave a truncated ideas.json behind. Only browser-created ideas go in
 * here: seeded ones are merged in on read.
 */
function writeStored(ideas: Idea[]): void {
  const tmp = `${IDEAS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ideas }, null, 2));
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
  if (!brand) return { ok: false, error: "brand is required" };
  if (!readBrands().some((b) => b.id === brand)) return { ok: false, error: `unknown brand: ${brand}` };
  if (!title) return { ok: false, error: "title is required" };
  if (!body) return { ok: false, error: "body is required" };

  const idea: Idea = {
    id: randomUUID(),
    brand,
    title,
    body,
    created_at: new Date().toISOString(),
    created_by,
  };

  // Read the stored list again right here rather than reusing an earlier read, so the
  // window between reading and writing is as short as it can be.
  writeStored([...readStored(), idea]);
  console.log(`[ideas] added ${idea.id} brand=${idea.brand} by=${idea.created_by}`);
  return { ok: true, idea };
}
