// The two append-only JSONL files behind the gift offer, and the only code that touches
// them. The signups file holds email addresses, so no line is ever logged. docs/JSONL-STORES.md

import { appendFileSync } from "fs";
import { join } from "path";
import { readJsonlObjects } from "./jsonl.ts";
import { STATE_DIR } from "./state-dir.ts";

export const SIGNUPS_FILE = join(STATE_DIR, "lp-aboard-signups.jsonl");
export const SENT_FILE = join(STATE_DIR, "lp-aboard-sent.jsonl");

export type SignupRow = Record<string, unknown>;

const TAG = "lp/aboard store";

/** Every stored submission, in the order it was written. Throws if the file cannot be read. */
export function readSignups(): { rows: SignupRow[]; malformed: number } {
  const { objects, malformed } = readJsonlObjects(SIGNUPS_FILE, TAG, "signups");
  return { rows: objects, malformed };
}

// The event ids already emailed. Throws when unreadable: an empty answer would email every
// signup twice. docs/JSONL-STORES.md
export function readSentEvents(): { events: Set<string>; malformed: number } {
  const { objects, malformed } = readJsonlObjects(SENT_FILE, TAG, "sent ledger");
  const events = new Set<string>();
  let bad = malformed;

  for (const row of objects) {
    if (typeof row.event === "string" && row.event) {
      events.add(row.event);
      continue;
    }
    // A ledger line with no event id marks nothing; it is counted so the reader can say so.
    bad++;
    console.error(`[lp/aboard store] sent ledger line has no event id, so it marks nothing. Open ${SENT_FILE}.`);
  }

  return { events, malformed: bad };
}

// Append one submission in one syscall. Throws if it did not land, and then no code may be
// handed out: the emailer reads this file and nothing else. docs/JSONL-STORES.md
export function appendSignup(row: SignupRow): void {
  appendFileSync(SIGNUPS_FILE, JSON.stringify(row) + "\n");
}

// Mark one signup as emailed, one line and one syscall per event, never a batch.
// Throws if it did not land. docs/JSONL-STORES.md
export function appendSent(event: string): void {
  appendFileSync(SENT_FILE, JSON.stringify({ event, sentAt: new Date().toISOString() }) + "\n");
}
