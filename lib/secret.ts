import { createHash, timingSafeEqual } from "crypto";

// The one constant-time secret check every server-to-server door uses; an empty secret
// matches nothing. Why hashed first: docs/SERVER-SECRETS.md
export function secretMatches(presented: string, configured: string): boolean {
  if (!configured || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}
