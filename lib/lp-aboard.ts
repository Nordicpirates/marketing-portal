// Public gift-offer page /lp/aboard and its claim endpoint.
//
// This is the only PUBLIC part of the portal. Everything else in server.ts sits
// behind the password gate; the retargeting audience arriving here has no login,
// so server.ts routes /lp/* before the auth check on purpose.
//
// No Shopify and no Brevo calls happen here. Submissions land in a JSONL file on
// the persistent volume and a separate process (Bengt, via Brevo) reads it.

import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "./state-dir.ts";
import { EDITIONS, OFFERS, buildCartUrl } from "./offer.js";

const REPO_DIR = join(import.meta.dir, "..");
const SIGNUPS_FILE = join(STATE_DIR, "lp-aboard-signups.jsonl");

// One code per offer, because they are two different Shopify BXGY rules: buying a
// base game grants one free gift, buying the BIG BOX grants both. A single shared
// code would let someone buying a base game claim both gifts.
//
// Rotatable without a code change: set GIFT_CODE_BASE / GIFT_CODE_BIGBOX in Studio
// settings. The page never hardcodes either - it only shows the one code this
// endpoint sends back, which is always the code for the offer that state is selling.
const CODE_BASE = (process.env.GIFT_CODE_BASE || "KRAKEN-A7F2").trim();
const CODE_BIGBOX = (process.env.GIFT_CODE_BIGBOX || "FULLHOLD-B642").trim();

const CODE_BY_OFFER: Record<string, string> = {
  "base-kraken": CODE_BASE,
  "base-coins": CODE_BASE,
  "bigbox-both": CODE_BIGBOX,
};

// The English Base Game ships from US and Australian stock, so we do not sell it
// into Europe. EU 27 + the three other EEA countries + GB.
const EUROPE = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
  "SE", // EU 27
  "IS", "LI", "NO", // rest of the EEA
  "GB",
]);

const BLOCKED_OFFERS = new Set(["base-kraken", "base-coins"]);

// Files the public page is allowed to pull. An explicit map, not a directory
// walk, so a stray file in public/ can never become publicly readable.
//
// The media is served from this repo, not hotlinked from the mockup share space.
// share.gate1.dev is where designs get reviewed; a live page that people are
// being paid to visit cannot have its hero video disappear when a mockup is
// tidied up. Markup and code stay on no-cache because they change; the media is
// immutable once committed, so it gets a real cache lifetime instead of being
// re-sent on every visit.
const NO_CACHE = "no-cache";
const CACHE_MEDIA = "public, max-age=604800";

const ASSETS: Record<string, { file: string; type: string; cache: string }> = {
  "/lp/aboard": { file: "public/lp-aboard.html", type: "text/html; charset=utf-8", cache: NO_CACHE },
  "/lp/aboard/style.css": { file: "public/lp-aboard.css", type: "text/css; charset=utf-8", cache: NO_CACHE },
  "/lp/aboard/page.js": { file: "public/lp-aboard.js", type: "text/javascript; charset=utf-8", cache: NO_CACHE },
  "/lp/aboard/offer.js": { file: "lib/offer.js", type: "text/javascript; charset=utf-8", cache: NO_CACHE },

  "/lp/aboard/media/lp-hero-poster.jpg": { file: "public/lp-aboard-media/lp-hero-poster.jpg", type: "image/jpeg", cache: CACHE_MEDIA },
  "/lp/aboard/media/lp-hero-1080.webm": { file: "public/lp-aboard-media/lp-hero-1080.webm", type: "video/webm", cache: CACHE_MEDIA },
  "/lp/aboard/media/lp-hero-1080.mp4": { file: "public/lp-aboard-media/lp-hero-1080.mp4", type: "video/mp4", cache: CACHE_MEDIA },
  "/lp/aboard/media/lp-gift-hero.jpg": { file: "public/lp-aboard-media/lp-gift-hero.jpg", type: "image/jpeg", cache: CACHE_MEDIA },
  "/lp/aboard/media/lp-gift-howto.jpg": { file: "public/lp-aboard-media/lp-gift-howto.jpg", type: "image/jpeg", cache: CACHE_MEDIA },
};

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();

/** First of these headers with something in it. */
function firstHeader(req: Request, names: string[]): string {
  for (const name of names) {
    const value = (req.headers.get(name) || "").trim();
    if (value) return value;
  }
  return "";
}

// The pretty URL nordicpirates.com/lp/aboard reaches this service through a
// Cloudflare Worker. On that hop the CF headers describe the worker, not the
// person, so the worker forwards the real visitor as x-visitor-*. Those win when
// present; direct traffic to marketing.nordicpirate.com has none of them and falls
// back to the CF headers exactly as before.
const IP_HEADERS = ["x-visitor-ip", "cf-connecting-ip"];
const COUNTRY_HEADERS = ["x-visitor-country", "cf-ipcountry"];

function clientIp(req: Request): string {
  const direct = firstHeader(req, IP_HEADERS);
  if (direct) return direct;
  // Last resort. Take the first hop, which is the client the edge saw.
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

function clientCountry(req: Request): string {
  return firstHeader(req, COUNTRY_HEADERS).toUpperCase();
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

/** Append one submission to the JSONL store. Never silently drops a signup. */
function record(entry: Record<string, unknown>): void {
  try {
    appendFileSync(SIGNUPS_FILE, JSON.stringify(entry) + "\n");
    console.log("[lp/aboard] stored", JSON.stringify(entry));
  } catch (err) {
    // A lost signup is the worst outcome here, so shout about it. The visitor
    // still gets their code - we are not going to punish them for our disk.
    console.error(`[lp/aboard] FAILED to write ${SIGNUPS_FILE}, signup not stored:`, JSON.stringify(entry), err);
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
      console.warn(`[lp/aboard] unparseable Range header for ${path}: ${JSON.stringify(range)}`);
      return new Response(file, { headers });
    }

    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      console.warn(`[lp/aboard] unsatisfiable range ${range} for ${path} (${size} bytes)`);
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    }

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
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    console.warn(`[lp/aboard] rate limited ${ip}`);
    return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
  }

  const body = await readBody(req);
  const email = (body.email || "").trim();
  const offer = (body.offer || "").trim();
  const edition = (body.edition || "").trim();
  const action = (body.action || "").trim();
  const honeypot = (body.company || "").trim();
  const country = clientCountry(req);

  // Honeypot is invisible to humans, so anything in it is a bot.
  if (honeypot) {
    console.warn(`[lp/aboard] honeypot filled from ${ip}, value: ${JSON.stringify(honeypot)}`);
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const problems: string[] = [];
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) problems.push("email");
  if (!OFFERS.includes(offer)) problems.push("offer");
  if (!EDITIONS.includes(edition)) problems.push("edition");
  if (action && action !== "rejoin") problems.push("action");

  if (problems.length) {
    console.warn(
      `[lp/aboard] rejected from ${ip}, bad fields: ${problems.join(",")}, raw:`,
      JSON.stringify({ email, offer, edition, action, country })
    );
    return Response.json({ error: `Invalid ${problems.join(", ")}` }, { status: 400 });
  }

  const blocked =
    edition === "en" && BLOCKED_OFFERS.has(offer) && EUROPE.has(country);
  const state = blocked ? "blocked" : "code";

  // The code issued for what they picked. This is the one that gets emailed, and
  // for a blocked visitor it stays valid for the Base Game in any other edition -
  // what the blocked copy calls "your original code".
  const issuedCode = CODE_BY_OFFER[offer];

  // The blocked state does not offer what they picked, it offers the BIG BOX in the
  // same edition, and a Base Game code does not fit a BIG BOX cart. So the state
  // shows the BIG BOX code and the cart link carries it. Every other state shows and
  // links the offer they actually chose.
  const target = blocked
    ? { offer: "bigbox-both", edition, code: CODE_BIGBOX }
    : { offer, edition, code: issuedCode };

  // Every submission is stored, blocked and rejoin included. Blocked people still
  // asked for a code, and Bengt still needs to mail it to them.
  //
  // "code" and "shownCode" are two fields more than issue #2 asked for. The codes are
  // meant to rotate and the emailer reads this file later, so it cannot re-derive
  // them: without them, a rotation means everyone who signed up before it gets mailed
  // a code they never saw. They differ only for a blocked visitor, who is issued the
  // Base Game code but is shown the BIG BOX one on screen.
  record({
    ts: new Date().toISOString(),
    email,
    offer,
    edition,
    country: country || null,
    action: action || null,
    state,
    code: issuedCode,
    shownCode: target.code,
  });

  // "code" and "cartUrl" always describe the state being shown, so they agree with
  // each other. The page rebuilds the same link from the same shared module, so if
  // these two ever disagree it is a bug in one of the two callers, not a mismatch
  // the visitor can end up clicking.
  const cartUrl = buildCartUrl(target.offer, target.edition, target.code);
  if (!cartUrl) {
    console.error(
      `[lp/aboard] no cart url for offer=${target.offer} edition=${target.edition} - check lib/offer.js`
    );
  }

  return Response.json({
    state,
    code: target.code,
    ...(cartUrl ? { cartUrl } : {}),
  });
}
