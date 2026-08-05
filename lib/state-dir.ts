import { mkdirSync } from "fs";
import { join } from "path";

// Persistent state dir. In prod this is the volume declared in gate.json
// ("./state:/app/state:rw"), so everything written here survives a redeploy.
// It sits outside public/, and no route serves files from it, so nothing in
// here is reachable over HTTP.
export const STATE_DIR = process.env.STATE_DIR || join(import.meta.dir, "..", "state");

try {
  mkdirSync(STATE_DIR, { recursive: true });
} catch (err) {
  // Not fatal on its own: the reader/writer that needs it will fail loudly and
  // say which file it could not touch. But never let this pass unseen.
  console.error(`[state] could not create STATE_DIR ${STATE_DIR}:`, err);
}
