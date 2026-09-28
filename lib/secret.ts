import { createHash, timingSafeEqual } from "crypto";

// The one constant-time secret check every secret door uses, the staff login included; an
// empty secret matches nothing. Why hashed first: docs/SERVER-SECRETS.md
export function secretMatches(presented: string, configured: string): boolean {
  if (!configured || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}

// A configured secret, read from the environment at call time and never cached; only an
// own property counts, never one inherited from Object.prototype. docs/SERVER-SECRETS.md
export function configuredSecret(name: string): string {
  return ((Object.hasOwn(process.env, name) && process.env[name]) || "").trim();
}
