// Public gift-offer page /lp/aboard and its claim endpoint.
//
// This is the only PUBLIC part of the portal. Everything else in server.ts sits
// behind the password gate; the retargeting audience arriving here has no login,
// so server.ts routes /lp/* before the auth check on purpose.
//
// No Shopify and no Brevo calls happen here. Submissions land in a JSONL file on
// the persistent volume and a separate process (Bengt, via Brevo) reads it.

import { appendFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
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
// These are UPSTREAM paths. The public URL is https://nordicpirates.com/gift-offer
// and the Cloudflare Worker rewrites it onto this service:
//
//   browser asks for            Worker sends us
//   /gift-offer                 /lp/aboard
//   /gift-offer/style.css       /lp/aboard/style.css
//   /gift-offer/page.js         /lp/aboard/page.js
//   /gift-offer/offer.js        /lp/aboard/offer.js
//   /gift-offer/media/<file>    /lp/aboard/media/<file>
//   POST /gift-offer/claim      POST /lp/aboard/claim
//
// So every path the PAGE emits is /gift-offer/... and every path THIS FILE knows
// is /lp/aboard/... . They are meant to differ. page.js imports "./offer.js",
// which the browser resolves against /gift-offer/page.js and therefore asks for
// /gift-offer/offer.js, which lands here as /lp/aboard/offer.js.
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

function header(req: Request, name: string): string {
  return (req.headers.get(name) || "").trim();
}

// The pretty URL nordicpirates.com/lp/aboard reaches this service through a
// Cloudflare Worker. On that hop the CF headers describe the worker, not the
// person, so the worker forwards the real visitor as x-visitor-ip and
// x-visitor-country.
//
// Those headers are just headers: anyone who can reach this origin directly can
// send them. Believed unconditionally they would hand an attacker a new identity
// per request - past the rate limit, past the Europe check, and straight into the
// signup file. So they are believed ONLY when the request also carries the shared
// secret the Worker holds. No secret, wrong secret, or no LP_PROXY_SECRET
// configured on this side means we ignore them entirely and use the CF headers.
//
// Fails closed on purpose: an unset LP_PROXY_SECRET trusts nothing.
const PROXY_SECRET = (process.env.LP_PROXY_SECRET || "").trim();

if (!PROXY_SECRET) {
  console.warn(
    "[lp/aboard] LP_PROXY_SECRET is not set: EVERY claim will be refused with 403 " +
      "and no codes will be issued. The page itself still serves. Set it here and on " +
      "the Worker before routing nordicpirates.com/gift-offer at this service."
  );
}

/**
 * Constant-time secret check.
 *
 * Both sides are hashed first so the comparison is always over two 32 byte
 * buffers. timingSafeEqual throws on a length mismatch, and calling it on the raw
 * strings would both leak the secret's length and turn a wrong-length guess into a
 * different, faster answer than a wrong-value guess.
 */
function secretMatches(presented: string): boolean {
  if (!PROXY_SECRET || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(PROXY_SECRET).digest();
  return timingSafeEqual(a, b);
}

/** True when this request proved it came through our Worker. */
function proxyIsTrusted(req: Request): boolean {
  const presented = header(req, "x-lp-proxy-secret");
  if (!presented) return false;
  return secretMatches(presented);
}

// Both of these are only ever called after the secret has been checked, so they
// read the Worker's headers and nothing else. There is deliberately no fallback to
// CF-Connecting-IP, X-Forwarded-For or CF-IPCountry: those are set by whoever can
// reach this origin, and a claim decision must not rest on them.
function clientIp(req: Request): string {
  const visitor = header(req, "x-visitor-ip");
  if (visitor) return visitor;
  // Authenticated but nothing forwarded. That is a broken Worker, not a visitor.
  // Everyone lands in one rate-limit bucket until it is fixed, which is the safe
  // way round.
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

// Logs go to the container log, which is a far looser thing than the signup file:
// it is shipped around, tailed in chat, and kept for as long as nobody prunes it.
// So nothing identifying goes in one. No email, no country, no IP, no discount
// code, no honeypot value, no raw request body. Only what the endpoint DID.
//
// Every stored submission gets an event id that goes into both the log line and
// the JSONL row, so a line in the log can be tied back to its record by whoever
// is allowed to open the protected file. The file stays the record; the log is
// only ever a trace of what happened.
function newEventId(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Append one submission to the JSONL store. Returns false if it did not land.
 *
 * The caller must not answer with a code when this returns false. The page tells
 * people the code is also on its way to their inbox, and the only thing that makes
 * that true is this file: the emailer reads it and nothing else. A code on screen
 * with no row in the file is a promise we have already broken.
 */
function record(entry: Record<string, unknown>, event: string): boolean {
  try {
    appendFileSync(SIGNUPS_FILE, JSON.stringify({ event, ...entry }) + "\n");
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
      // Suffix form. "bytes=-500" is the LAST 500 bytes, not the first 500. Getting
      // this backwards hands the player the start of the file when it asked for the
      // end, which for an mp4 is where the moov atom lives on a non-faststart file.
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
  // The claim endpoint is reachable only through the Cloudflare Worker, so it
  // refuses anything that cannot prove it came from there. Nothing is parsed,
  // nothing is stored, and no code is handed out until the secret checks out.
  //
  // Failing closed here rather than falling back to the CF headers is the whole
  // point: at the origin those are just headers, and believing them would let
  // anyone who can reach this host pick their own country and their own identity
  // per request. An unset LP_PROXY_SECRET matches nothing, so an unconfigured
  // deploy issues no codes at all rather than issuing them to everybody.
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

  // This endpoint proves nothing about who owns the address it is given, so it
  // must not carry an instruction about somebody's mailing list. Anyone could post
  // a victim's address and have us write down that they asked to be re-subscribed.
  // Any action field at all is refused, and no action is ever stored, so the Brevo
  // job downstream has nothing here it could mistake for consent. Putting people
  // back on a list needs a confirmed-email flow, which is not this.
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

  // Every submission is stored, blocked ones included. Blocked people still asked
  // for a code, and Bengt still needs to mail it to them.
  //
  // "code" and "shownCode" are two fields more than issue #2 asked for. The codes are
  // meant to rotate and the emailer reads this file later, so it cannot re-derive
  // them: without them, a rotation means everyone who signed up before it gets mailed
  // a code they never saw. They differ only for a blocked visitor, who is issued the
  // Base Game code but is shown the BIG BOX one on screen.
  //
  // There is no "action" field any more. Nothing this endpoint receives is proof of
  // anything about the address, so it stores facts about the request and no
  // instructions about anyone's subscription.
  const event = newEventId();
  const stored = record(
    {
      ts: new Date().toISOString(),
      email,
      offer,
      edition,
      country: country || null,
      state,
      code: issuedCode,
      shownCode: target.code,
    },
    event
  );

  // The write failed, so nobody is going to email this person anything. Saying
  // "your code is on its way to your inbox" now would be a lie, and handing over a
  // working code we have no record of issuing is worse. Ask them to try again.
  if (!stored) {
    return Response.json(
      { error: "We could not issue your code just now. Please try again in a moment." },
      { status: 503 }
    );
  }

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
