import { createHash, timingSafeEqual } from "crypto";

/**
 * Constant-time shared secret check, used by every server-to-server door in this
 * service: the Worker in front of the gift page and the emailer behind it.
 *
 * Both sides are hashed first so the comparison is always over two 32 byte
 * buffers. timingSafeEqual throws on a length mismatch, and calling it on the raw
 * strings would both leak the secret's length and turn a wrong-length guess into a
 * different, faster answer than a wrong-value guess.
 *
 * An empty configured secret matches nothing, so a service that was deployed
 * without one refuses everybody instead of letting everybody in.
 */
export function secretMatches(presented: string, configured: string): boolean {
  if (!configured || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}
