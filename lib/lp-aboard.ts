// Public gift-offer page /lp/aboard and its claim endpoint, the only PUBLIC part of the
// portal. How it is reached and trusted: docs/GIFT-OFFER-WORKER.md

import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { SIGNUPS_FILE, appendSignup } from "./lp-aboard-store.ts";
import { configuredSecret, secretMatches } from "./secret.ts";
import { EDITIONS, OFFERS, buildCartUrl, enBasePreorder } from "./offer.js";

const REPO_DIR = join(import.meta.dir, "..");

// One code per offer, two BXGY rules, so a base game cannot claim both gifts; rotated
// by env. docs/GIFT-OFFER-CLAIM.md
const CODE_BASE = (process.env.GIFT_CODE_BASE || "KRAKEN-A7F2").trim();
const CODE_BIGBOX = (process.env.GIFT_CODE_BIGBOX || "FULLHOLD-B642").trim();

const CODE_BY_OFFER: Record<string, string> = {
  "base-kraken": CODE_BASE,
  "base-coins": CODE_BASE,
  "bigbox-both": CODE_BIGBOX,
};

// The two offers whose box is a Base Game, the only box with a pre-order print.
const BASE_OFFERS = new Set(["base-kraken", "base-coins"]);

// The hop's own words for "we do not know where this is", never read as a country.
// docs/GIFT-OFFER-CLAIM.md
const UNPLACEABLE = new Set(["", "XX", "T1"]);

// Upstream paths the Worker maps /gift-offer onto: docs/GIFT-OFFER-WORKER.md. An explicit
// map so no stray file is public, media cached, code not: docs/GIFT-OFFER-ASSETS.md
const NO_CACHE = "no-cache";
const CACHE_MEDIA = "public, max-age=604800";
const JS = "text/javascript; charset=utf-8";

// Same list as LANGUAGES in public/lp-aboard-i18n.js, or a language would render blank.
// docs/GIFT-OFFER-ASSETS.md
const LANGUAGE_ASSETS = ["en", "de", "it", "fr", "es"];

const ASSETS: Record<string, { file: string; type: string; cache: string }> = {
  "/lp/aboard": { file: "public/lp-aboard.html", type: "text/html; charset=utf-8", cache: NO_CACHE },
  "/lp/aboard/style.css": { file: "public/lp-aboard.css", type: "text/css; charset=utf-8", cache: NO_CACHE },
  "/lp/aboard/page.js": { file: "public/lp-aboard.js", type: JS, cache: NO_CACHE },
  "/lp/aboard/cart.js": { file: "public/lp-aboard-cart.js", type: JS, cache: NO_CACHE },
  "/lp/aboard/offer.js": { file: "lib/offer.js", type: JS, cache: NO_CACHE },
  "/lp/aboard/i18n.js": { file: "public/lp-aboard-i18n.js", type: JS, cache: NO_CACHE },
  ...Object.fromEntries(
    LANGUAGE_ASSETS.map((lang) => [
      `/lp/aboard/i18n-${lang}.js`,
      { file: `public/lp-aboard-i18n-${lang}.js`, type: JS, cache: NO_CACHE },
    ])
  ),

  "/lp/aboard/media/lp-hero-poster.jpg": { file: "public/lp-aboard-media/lp-hero-poster.jpg", type: "image/jpeg", cache: CACHE_MEDIA },
  "/lp/aboard/media/lp-hero-1080.webm": { file: "public/lp-aboard-media/lp-hero-1080.webm", type: "video/webm", cache: CACHE_MEDIA },
  "/lp/aboard/media/lp-hero-1080.mp4": { file: "public/lp-aboard-media/lp-hero-1080.mp4", type: "video/mp4", cache: CACHE_MEDIA },
  "/lp/aboard/media/lp-gift-hero.jpg": { file: "public/lp-aboard-media/lp-gift-hero.jpg", type: "image/jpeg", cache: CACHE_MEDIA },
  "/lp/aboard/media/lp-gift-howto.jpg": { file: "public/lp-aboard-media/lp-gift-howto.jpg", type: "image/jpeg", cache: CACHE_MEDIA },
  "/lp/aboard/media/asul-400.woff2": { file: "public/lp-aboard-media/asul-400.woff2", type: "font/woff2", cache: CACHE_MEDIA },
  "/lp/aboard/media/asul-700.woff2": { file: "public/lp-aboard-media/asul-700.woff2", type: "font/woff2", cache: CACHE_MEDIA },
  "/lp/aboard/media/cinzel.woff2": { file: "public/lp-aboard-media/cinzel.woff2", type: "font/woff2", cache: CACHE_MEDIA },
  "/lp/aboard/media/base.webp": { file: "public/lp-aboard-media/base.webp", type: "image/webp", cache: CACHE_MEDIA },
  "/lp/aboard/media/gift-crew.webp": { file: "public/lp-aboard-media/gift-crew.webp", type: "image/webp", cache: CACHE_MEDIA },
  "/lp/aboard/media/gift-table.webp": { file: "public/lp-aboard-media/gift-table.webp", type: "image/webp", cache: CACHE_MEDIA },
  "/lp/aboard/media/mu-thumb.webp": { file: "public/lp-aboard-media/mu-thumb.webp", type: "image/webp", cache: CACHE_MEDIA },
  "/lp/aboard/media/logo-lp.png": { file: "public/lp-aboard-media/logo-lp.png", type: "image/png", cache: CACHE_MEDIA },
  "/lp/aboard/media/logo-np.png": { file: "public/lp-aboard-media/logo-np.png", type: "image/png", cache: CACHE_MEDIA },
};

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();

function header(req: Request, name: string): string {
  return (req.headers.get(name) || "").trim();
}

// Read here only to warn at startup: forwarded headers need the Worker's secret, and an
// unset LP_PROXY_SECRET trusts nothing. docs/GIFT-OFFER-WORKER.md
if (!configuredSecret("LP_PROXY_SECRET")) {
  console.warn(
    "[lp/aboard] LP_PROXY_SECRET is not set: EVERY claim will be refused with 403 " +
      "and no codes will be issued. The page itself still serves. Set it here and on " +
      "the Worker before routing nordicpirates.com/gift-offer at this service."
  );
}

// True when this request proved it came through our Worker; the compare is shared with
// lib/lp-aboard-admin.ts in secretMatches. docs/GIFT-OFFER-WORKER.md
function proxyIsTrusted(req: Request): boolean {
  // Read on every claim, never frozen at import. docs/SERVER-SECRETS.md
  return secretMatches(header(req, "x-lp-proxy-secret"), configuredSecret("LP_PROXY_SECRET"));
}

// Called only after the secret checks out, and deliberately with no fallback to headers
// anyone can set. docs/GIFT-OFFER-WORKER.md
function clientIp(req: Request): string {
  const visitor = header(req, "x-visitor-ip");
  if (visitor) return visitor;
  // A broken Worker, not a visitor: one shared rate-limit bucket is the safe way round.
  console.warn("[lp/aboard] authenticated request carried no x-visitor-ip: check the Worker");
  return "unknown";
}

function clientCountry(req: Request): string {
  return header(req, "x-visitor-country").toUpperCase();
}

/** True when this IP has already used its 10 submissions this hour. */
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);

  // In-memory and this process runs for weeks, so drop IPs whose window has
  // fully expired rather than growing the map forever.
  if (hits.size > 5000) {
    for (const [key, stamps] of hits) {
      if (!stamps.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

// Deliberately loose: something@something.tld. Anything stricter starts rejecting
// real addresses, and the real proof an address works is the email that follows.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// RFC 5321 caps a forward path at 254 characters. Anything longer is not an address
// anyone owns, and without a cap it is a free way to pad the JSONL store.
const EMAIL_MAX = 254;

type ClaimBody = Record<string, string>;

/** Accepts both JSON (what the page sends) and a plain form post. */
async function readBody(req: Request): Promise<ClaimBody> {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const raw = await req.json().catch((err) => {
      console.warn("[lp/aboard] body was not valid JSON:", err);
      return {};
    });
    const out: ClaimBody = {};
    for (const [k, v] of Object.entries(raw || {})) out[k] = v == null ? "" : String(v);
    return out;
  }
  const form = await req.formData().catch((err) => {
    console.warn("[lp/aboard] body was not a readable form:", err);
    return null;
  });
  const out: ClaimBody = {};
  if (form) for (const [k, v] of form.entries()) out[k] = v.toString();
  return out;
}

// Logs carry nothing identifying; this id ties a log line to its stored row instead.
// docs/GIFT-OFFER-CLAIM.md
function newEventId(): string {
  return randomBytes(6).toString("hex");
}

// Append one submission; false means it did not land, and then no code may be shown.
// docs/GIFT-OFFER-CLAIM.md
function record(entry: Record<string, unknown>, event: string): boolean {
  try {
    appendSignup({ event, ...entry });
    console.log(
      `[lp/aboard] claim stored event=${event} state=${entry.state} offer=${entry.offer} edition=${entry.edition}`
    );
    return true;
  } catch (err) {
    console.error(
      `[lp/aboard] FAILED to write ${SIGNUPS_FILE}, signup NOT stored event=${event} ` +
        `state=${entry.state} offer=${entry.offer} edition=${entry.edition}:`,
      err
    );
    return false;
  }
}

export function handleAsset(path: string, req?: Request): Response | null {
  const asset = ASSETS[path];
  if (!asset) return null;

  const full = join(REPO_DIR, asset.file);
  if (!existsSync(full)) {
    console.error(`[lp/aboard] missing asset ${asset.file} for ${path}`);
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(full);
  const headers: Record<string, string> = {
    "Content-Type": asset.type,
    // Belt and braces with the noindex meta tag in the HTML: this page is for
    // people who clicked an ad, not for search engines.
    "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": asset.cache,
    // The hero video needs this. Safari asks for a byte range before it will play
    // anything, and a server that answers 200-with-everything gets no video.
    "Accept-Ranges": "bytes",
  };

  const range = req?.headers.get("range");
  if (range) {
    const size = file.size;
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      // Malformed. RFC 7233 says ignore the header and send the whole thing.
      console.warn(`[lp/aboard] unparseable Range header for ${path}, serving whole file`);
      return new Response(file, { headers });
    }

    const [, rawStart, rawEnd] = match;
    const unsatisfiable = () => {
      console.warn(`[lp/aboard] unsatisfiable range for ${path} (${size} bytes)`);
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    };

    let start: number;
    let end: number;

    if (rawStart === "") {
      // Suffix form: "bytes=-500" is the LAST 500 bytes, where an mp4 may keep its moov atom.
      // docs/GIFT-OFFER-ASSETS.md
      const suffix = parseInt(rawEnd, 10);
      if (!rawEnd || Number.isNaN(suffix) || suffix <= 0) return unsatisfiable();
      // A suffix longer than the file just means the whole file.
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(rawStart, 10);
      end = rawEnd ? parseInt(rawEnd, 10) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return unsatisfiable();
      }
      // "bytes=0-99999999" on a small file is legal: clamp, do not refuse.
      end = Math.min(end, size - 1);
    }

    if (size === 0 || end < start) return unsatisfiable();

    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(file, { headers });
}

export async function handleClaim(req: Request): Promise<Response> {
  // Nothing is parsed, stored or issued until the Worker's secret checks out; unset, it
  // matches nothing, so an unconfigured deploy issues no codes. docs/GIFT-OFFER-WORKER.md
  if (!proxyIsTrusted(req)) {
    console.warn("[lp/aboard] claim rejected reason=unauthenticated");
    return Response.json({ error: "Not available here" }, { status: 403 });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    console.warn("[lp/aboard] claim rejected reason=rate-limited");
    return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
  }

  const body = await readBody(req);
  const email = (body.email || "").trim();
  const offer = (body.offer || "").trim();
  const edition = (body.edition || "").trim();
  const honeypot = (body.company || "").trim();
  const country = clientCountry(req);

  // Honeypot is invisible to humans, so anything in it is a bot.
  if (honeypot) {
    console.warn("[lp/aboard] claim rejected reason=honeypot");
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  // No proof of who owns the address, so no mailing-list instruction may ride along.
  // docs/GIFT-OFFER-CLAIM.md
  if ("action" in body) {
    console.warn("[lp/aboard] claim rejected reason=action-not-accepted");
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  const problems: string[] = [];
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) problems.push("email");
  if (!OFFERS.includes(offer)) problems.push("offer");
  if (!EDITIONS.includes(edition)) problems.push("edition");

  if (problems.length) {
    // Field names only. The values are attacker controlled and one of them is an
    // email address, so neither belongs in a log line.
    console.warn(`[lp/aboard] claim rejected reason=invalid-fields fields=${problems.join(",")}`);
    return Response.json({ error: `Invalid ${problems.join(", ")}` }, { status: 400 });
  }

  // English Base Game: US stock where lib/offer.js says so, the pre-order print everywhere
  // else and when the country is unknown, which ships anywhere. docs/GIFT-OFFER-CLAIM.md
  const englishBase = edition === "en" && BASE_OFFERS.has(offer);
  const countryKnown = !UNPLACEABLE.has(country);

  if (englishBase && !countryKnown) {
    // Which kind of unknown, never the header: the two need different fixers.
    console.warn(
      `[lp/aboard] trusted hop could not place this visitor (${country ? "not a country" : "nothing sent"}), ` +
        "selling the English base game as the pre-order print: check the Worker forwards x-visitor-country"
    );
  }

  const preorder = englishBase && (!countryKnown || enBasePreorder(country));
  // Every box ships somewhere now, so every claim gets the code for what it picked.
  const state = "code";
  const code = CODE_BY_OFFER[offer];

  // Every submission is stored. Rows keep shownCode for the emailer: docs/GIFT-EMAIL.md
  const event = newEventId();
  const stored = record(
    {
      ts: new Date().toISOString(),
      email,
      offer,
      edition,
      country: country || null,
      state,
      preorder,
      code,
      shownCode: code,
    },
    event
  );

  // Not stored means never emailed, so no code and no inbox promise: ask them to retry.
  if (!stored) {
    return Response.json(
      { error: "We could not issue your code just now. Please try again in a moment." },
      { status: 503 }
    );
  }

  // Built from the same module the page uses, so link and cart agree. docs/GIFT-OFFER-CLAIM.md
  const cartUrl = buildCartUrl(offer, edition, code, preorder);
  if (!cartUrl) {
    console.error(`[lp/aboard] no cart url for offer=${offer} edition=${edition} - check lib/offer.js`);
  }

  return Response.json({
    state,
    code,
    ...(preorder ? { preorder } : {}),
    ...(cartUrl ? { cartUrl } : {}),
  });
}
