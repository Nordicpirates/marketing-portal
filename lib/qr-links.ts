// Counted QR links: the registry in data/qr-links.json, the scan log the edge feeds through
// POST /qr/hit, and the numbers GET /api/qr hands the /qr page. docs/QR-LINKS.md

import { appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { readJsonlObjects } from "./jsonl.ts";
import { configuredSecret, secretMatches } from "./secret.ts";
import { STATE_DIR } from "./state-dir.ts";
import { stockholmDay } from "./stockholm-day.js";

export { stockholmDay };

export const REGISTRY_FILE = join(import.meta.dir, "..", "data", "qr-links.json");
export const SCANS_FILE = join(STATE_DIR, "qr-scans.jsonl");
export const TIME_ZONE = "Europe/Stockholm";
export const DAYS_SHOWN = 30;
const DEVICES = ["ios", "android", "other"] as const;
const NO_STORE = { "Cache-Control": "no-store" };

export type QrLink = {
  slug: string;
  name: string;
  where?: string;
  destination: string;
  created?: string;
  requested_by?: string;
};
export type DirectCode = { name: string; url: string; created?: string };
export type Registry = { base: string; links: QrLink[]; direct: DirectCode[] };
export type Scan = { slug: string; at: string; country: string; device: string; visitor: string; test: boolean };

// Read here only to warn at startup; every hit reads it again. docs/SERVER-SECRETS.md
if (!configuredSecret("QR_HIT_SECRET")) {
  console.warn(
    "[qr] QR_HIT_SECRET is not set: every POST /qr/hit will be refused with 403, so no scan " +
      "is counted. The redirects still work, they run at the edge. Set it here and on the edge."
  );
}

/** The registry as committed. Throws when the file is missing or is not a registry. */
export function readRegistry(): Registry {
  const raw = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.links)) {
    throw new Error(`${REGISTRY_FILE} has no "links" list, so it is not the QR registry`);
  }
  return { base: String(raw.base || ""), links: raw.links, direct: Array.isArray(raw.direct) ? raw.direct : [] };
}


/** The last n Stockholm days ending today, oldest first. */
export function lastDays(now: Date, n: number): string[] {
  const [y, m, d] = stockholmDay(now).split("-").map(Number);
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) days.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return days;
}

// A hit becomes a stored scan only for a registered slug; every other field is coerced to
// its known shape, never trusted as sent.
export function scanFromHit(body: unknown, registry: Registry, at: Date): { ok: true; scan: Scan } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const slug = typeof b.slug === "string" ? b.slug : "";
  if (!registry.links.some((l) => l.slug === slug)) return { ok: false, error: "unknown slug" };
  const country = typeof b.country === "string" && /^[A-Z]{2}$/.test(b.country) ? b.country : "XX";
  const device = (DEVICES as readonly string[]).includes(b.device as string) ? (b.device as string) : "other";
  const visitor = typeof b.visitor === "string" && /^[0-9a-f]{16}$/.test(b.visitor) ? b.visitor : "";
  return { ok: true, scan: { slug, at: at.toISOString(), country, device, visitor, test: b.test === true } };
}

// POST /qr/hit from the edge, behind x-qr-hit-secret: one scan, one appended line.
// docs/QR-LINKS.md
export async function handleHit(req: Request): Promise<Response> {
  if (!secretMatches((req.headers.get("x-qr-hit-secret") || "").trim(), configuredSecret("QR_HIT_SECRET"))) {
    console.warn("[qr] hit rejected reason=unauthenticated");
    return Response.json({ error: "Not available here" }, { status: 403, headers: NO_STORE });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "Use POST" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
  }

  const body = await req.json().catch(() => null);
  let checked: ReturnType<typeof scanFromHit>;
  try {
    checked = scanFromHit(body, readRegistry(), new Date());
  } catch (err) {
    console.error("[qr] the registry could not be read, so the hit was not stored:", err);
    return Response.json({ error: "The QR registry is unavailable" }, { status: 503, headers: NO_STORE });
  }
  if (!checked.ok) {
    console.warn(`[qr] hit rejected reason=${checked.error}`);
    return Response.json({ error: checked.error }, { status: 400, headers: NO_STORE });
  }

  try {
    appendFileSync(SCANS_FILE, JSON.stringify(checked.scan) + "\n");
  } catch (err) {
    console.error(`[qr] FAILED to append ${SCANS_FILE} slug=${checked.scan.slug}:`, err);
    return Response.json({ error: "The scan could not be stored" }, { status: 503, headers: NO_STORE });
  }
  console.log(`[qr] hit slug=${checked.scan.slug} test=${checked.scan.test}`);
  return new Response(null, { status: 204, headers: NO_STORE });
}

type LinkStats = {
  total: number;
  unique: number;
  today: number;
  last7: number;
  last30: number;
  daily: number[];
  countries: { code: string; scans: number }[];
  devices: Record<string, number>;
  first_scan: string | null;
  last_scan: string | null;
  last_test: string | null;
};

// Everything the /qr page draws, counted in Stockholm days. Test scans are kept apart and
// only their latest time is shown. docs/QR-LINKS.md
export function qrStats(registry: Registry, scans: Scan[], now: Date) {
  const days = lastDays(now, DAYS_SHOWN);
  const index = new Map(days.map((d, i) => [d, i]));
  const today = days[days.length - 1];
  const weekStart = days[days.length - 7];

  const acc = new Map<string, LinkStats & { visitors: Set<string>; countryMap: Map<string, number> }>();
  for (const link of registry.links) {
    acc.set(link.slug, {
      total: 0, unique: 0, today: 0, last7: 0, last30: 0,
      daily: days.map(() => 0), countries: [], devices: { ios: 0, android: 0, other: 0 },
      first_scan: null, last_scan: null, last_test: null,
      visitors: new Set(), countryMap: new Map(),
    });
  }

  for (const scan of scans) {
    const s = acc.get(scan.slug);
    if (!s) continue;
    if (scan.test) {
      if (!s.last_test || scan.at > s.last_test) s.last_test = scan.at;
      continue;
    }
    const day = stockholmDay(new Date(scan.at));
    s.total++;
    // One phone scanning twice on one day is one unique scan; the hash changes every day.
    if (scan.visitor) s.visitors.add(`${day}|${scan.visitor}`);
    else s.unique++;
    if (day === today) s.today++;
    if (day >= weekStart) s.last7++;
    const i = index.get(day);
    if (i !== undefined) {
      s.daily[i]++;
      s.last30++;
    }
    s.devices[scan.device] = (s.devices[scan.device] || 0) + 1;
    s.countryMap.set(scan.country, (s.countryMap.get(scan.country) || 0) + 1);
    if (!s.first_scan || scan.at < s.first_scan) s.first_scan = scan.at;
    if (!s.last_scan || scan.at > s.last_scan) s.last_scan = scan.at;
  }

  const links = registry.links.map((link) => {
    const { visitors, countryMap, ...s } = acc.get(link.slug)!;
    const url = `${registry.base}/${link.slug}`;
    return {
      ...link,
      url,
      files: {
        svg: `${registry.base}/files/${link.slug}.svg`,
        png: `${registry.base}/files/${link.slug}.png`,
        pdf: `${registry.base}/files/${link.slug}.pdf`,
      },
      ...s,
      unique: s.unique + visitors.size,
      countries: [...countryMap].map(([code, n]) => ({ code, scans: n })).sort((a, b) => b.scans - a.scans || a.code.localeCompare(b.code)),
    };
  });

  return { generated_at: now.toISOString(), time_zone: TIME_ZONE, base: registry.base, days, links, direct: registry.direct };
}

/** Every stored scan in a usable shape, plus how many lines were not. Throws when unreadable. */
export function readScans(): { scans: Scan[]; malformed: number } {
  const { objects, malformed } = readJsonlObjects(SCANS_FILE, "qr", "scans");
  const scans: Scan[] = [];
  let bad = malformed;
  for (const o of objects) {
    if (typeof o.slug !== "string" || typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) {
      bad++;
      continue;
    }
    scans.push({
      slug: o.slug,
      at: o.at,
      country: typeof o.country === "string" ? o.country : "XX",
      device: typeof o.device === "string" ? o.device : "other",
      visitor: typeof o.visitor === "string" ? o.visitor : "",
      test: o.test === true,
    });
  }
  return { scans, malformed: bad };
}

// GET /api/qr, behind the staff password. A store that cannot be read is a 503, never an
// empty list: "nobody scanned" would be the one wrong answer.
export function handleStats(): Response {
  try {
    const { scans, malformed } = readScans();
    const stats = qrStats(readRegistry(), scans, new Date());
    return Response.json(
      { ...stats, ...(malformed ? { problems: { malformedLines: malformed } } : {}) },
      { headers: { "Cache-Control": "no-cache" } }
    );
  } catch (err) {
    console.error("[qr] the scan numbers could not be read:", err);
    return Response.json(
      { error: "The QR numbers could not be read. This has been logged for an operator." },
      { status: 503, headers: NO_STORE }
    );
  }
}
