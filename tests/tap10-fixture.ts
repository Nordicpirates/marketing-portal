// The hand-made TAP 10 fixtures and one way to run the builder on them, shared by the
// builder, page and API tests. No real contact data: tests/fixtures/tap10 holds ids only.

import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
export const FIX = join(import.meta.dir, "fixtures", "tap10");
const SCRIPT = join(REPO, "scripts", "tap10_snapshot.py");

export const FULL_ARGS = [
  "--since", "2026-10-06", "--until", "2026-10-09", "--today", "2026-10-09",
  "--brevo-contacts", join(FIX, "brevo"), "--ga", join(FIX, "ga.json"), "--ads", join(FIX, "ads.json"),
  "--ks-csv", join(FIX, "kickstarter-followers.csv"),
  "--ks-pageviews", join(FIX, "pageviews-a.json"), "--ks-pageviews", join(FIX, "pageviews-b.json"),
];

/** Run the builder into a temp file; out is null when it refused. */
export function build(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "tap10-build-"));
  const outPath = join(dir, "tap10.json");
  const run = Bun.spawnSync(["python3", "-I", SCRIPT, ...args, "--out", outPath]);
  const out = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null;
  return { code: run.exitCode, stderr: run.stderr.toString(), out, outPath, dir };
}

