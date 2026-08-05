// The two JSONL files behind the gift offer, and the only code that touches them.
//
//   lp-aboard-signups.jsonl  one line per submission, written by the claim endpoint
//   lp-aboard-sent.jsonl     one line per signup the emailer has sent the code for
//
// Both live in STATE_DIR, which is the persistent volume in production, and neither
// is reachable over HTTP: no route serves files from that directory.
//
// Two append only files rather than one file we rewrite. A submission is never
// edited after it lands, so a crash halfway through a write can cost the last line
// but can never damage an earlier one, and the claim endpoint never has to read
// back what it wrote. Marking a signup as sent adds a line to the second file
// instead of touching the first.
//
// The signups file holds email addresses. That is why nothing in here ever logs the
// contents of a line, not even in an error: a file name and a line number are
// enough to go and look at the real file, and the container log is a much looser
// place than the volume.

import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "./state-dir.ts";

export const SIGNUPS_FILE = join(STATE_DIR, "lp-aboard-signups.jsonl");
export const SENT_FILE = join(STATE_DIR, "lp-aboard-sent.jsonl");

export type SignupRow = Record<string, unknown>;

/**
 * Read a JSONL file into objects, in file order.
 *
 * A file that is not there yet is not a problem: nobody has signed up, or nobody
 * has been emailed yet. A file that IS there but cannot be read is a real failure
 * and throws, because answering "no rows" to that question would tell the emailer
 * there is no work when there may be plenty.
 *
 * A line that will not parse is counted and reported to the caller rather than
 * quietly dropped. The line itself never reaches the log, and neither does the
 * parser's error message, because both can quote the input and the input can be an
 * email address.
 */
function readObjects(file: string, label: string): { objects: Record<string, unknown>[]; malformed: number } {
  if (!existsSync(file)) return { objects: [], malformed: 0 };

  const lines = readFileSync(file, "utf8").split("\n");
  const objects: Record<string, unknown>[] = [];
  let malformed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      console.error(
        `[lp/aboard store] ${label} line ${i + 1} is not valid JSON and was skipped. ` +
          `The line is not logged: it can hold an email address. Open ${file} to see it.`
      );
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformed++;
      console.error(
        `[lp/aboard store] ${label} line ${i + 1} is valid JSON but not an object, so it was skipped. ` +
          `Open ${file} to see it.`
      );
      continue;
    }

    objects.push(parsed as Record<string, unknown>);
  }

  return { objects, malformed };
}

/** Every stored submission, in the order it was written. Throws if the file cannot be read. */
export function readSignups(): { rows: SignupRow[]; malformed: number } {
  const { objects, malformed } = readObjects(SIGNUPS_FILE, "signups");
  return { rows: objects, malformed };
}

/**
 * The event ids the emailer has already sent a code for. Throws if the file cannot
 * be read, for the same reason as above: an unreadable ledger read as "empty" would
 * hand every already emailed signup back for a second email.
 */
export function readSentEvents(): { events: Set<string>; malformed: number } {
  const { objects, malformed } = readObjects(SENT_FILE, "sent ledger");
  const events = new Set<string>();
  let bad = malformed;

  for (const row of objects) {
    if (typeof row.event === "string" && row.event) {
      events.add(row.event);
      continue;
    }
    // A ledger line with no event id marks nothing, so it cannot be acted on. It is
    // counted so the reader can say something is wrong with the file.
    bad++;
    console.error(`[lp/aboard store] sent ledger line has no event id, so it marks nothing. Open ${SENT_FILE}.`);
  }

  return { events, malformed: bad };
}

/**
 * Append one submission. Throws if it did not land, and the caller must not answer
 * with a code when it does: the emailer reads this file and nothing else.
 *
 * One appendFileSync per row, so the row is written by a single append syscall.
 * Two writers cannot interleave halfway through a line.
 */
export function appendSignup(row: SignupRow): void {
  appendFileSync(SIGNUPS_FILE, JSON.stringify(row) + "\n");
}

/**
 * Mark one signup as emailed. Throws if it did not land, so the caller can report
 * exactly which ids made it into the ledger and which did not.
 *
 * One line per event, one append syscall per line. There is no batch write on
 * purpose: a half written batch would leave the caller unable to say what was
 * marked, and marking a code as sent when it was not means the person never gets
 * their email.
 */
export function appendSent(event: string): void {
  appendFileSync(SENT_FILE, JSON.stringify({ event, sentAt: new Date().toISOString() }) + "\n");
}
