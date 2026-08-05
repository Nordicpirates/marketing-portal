// Tests for the /lp/aboard gift offer page and its claim endpoint.
//
// These check what the page SHOULD do, straight off the acceptance criteria in
// issue #2 and the two spec updates: the right variant per edition, the right code
// per offer, and the English base game refused inside Europe.
//
// The handlers are called directly with Request objects. No server is started.

import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the store at a scratch dir BEFORE the module reads it at import time.
const TEST_STATE = mkdtempSync(join(tmpdir(), "lp-aboard-test-"));
process.env.STATE_DIR = TEST_STATE;

// The Worker's shared secret. Set before the module reads it at import time.
const PROXY_SECRET = "test-proxy-secret-2f8a1c";
process.env.LP_PROXY_SECRET = PROXY_SECRET;

const SIGNUPS = join(TEST_STATE, "lp-aboard-signups.jsonl");

// Variant IDs from the authoritative map in issue #2.
const BASE_EN = "51542813409627";
const BASE_FR = "51542813442395";
const BASE_DE = "51542813540699";
const BIGBOX_EN = "51542655959387";
const KRAKEN = "51542942318939";
const COINS = "51676501508443";

let handleClaim: (req: Request) => Promise<Response>;
let handleAsset: (path: string) => Response | null;

beforeAll(async () => {
  const mod = await import("../lib/lp-aboard.ts");
  handleClaim = mod.handleClaim;
  handleAsset = mod.handleAsset;
});

/**
 * One claim POST as it arrives from the Worker: carrying the shared secret and the
 * forwarded visitor. Each caller gets its own IP so the rate limit stays out of the
 * way. Requests WITHOUT the secret are the unauthenticated tests, further down.
 */
function claim(
  body: Record<string, string>,
  opts: { country?: string; ip?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-lp-proxy-secret": PROXY_SECRET,
    "x-visitor-ip": opts.ip || `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
  };
  if (opts.country) headers["x-visitor-country"] = opts.country;
  return handleClaim(
    new Request("https://nordicpirates.com/lp/aboard/claim", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
}

/** A claim carrying whatever raw headers the caller wants. */
function claimWithHeaders(body: Record<string, string>, headers: Record<string, string>): Promise<Response> {
  return handleClaim(
    new Request("https://nordicpirates.com/lp/aboard/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

function storedLines(): Record<string, any>[] {
  if (!existsSync(SIGNUPS)) return [];
  return readFileSync(SIGNUPS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("GET /lp/aboard returns the real page with a noindex header", () => {
  const res = handleAsset("/lp/aboard");
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  expect(res!.headers.get("X-Robots-Tag")).toContain("noindex");
  expect(res!.headers.get("Content-Type")).toContain("text/html");
});

test("the page ships real copy, not a placeholder", async () => {
  const html = await handleAsset("/lp/aboard")!.text();
  expect(html).toContain("We will not have a better offer than this.");
  expect(html).toContain('id="giftform"');
  // The review-only scaffolding from the mockup must be gone.
  expect(html).not.toContain("shown here for review only");
  expect(html).not.toContain("review-flag");
  expect(html).not.toContain("AI-AGENT-INSTRUCTIONS");
  expect(html).not.toContain("MOCKUP-WIDGET");
  expect(html).not.toContain("TODO-BENGT-ENDPOINT");
});

test("the mockup media is served from this repo, not hotlinked from the share space", async () => {
  const media = [
    ["/lp/aboard/media/lp-hero-poster.jpg", "image/jpeg"],
    ["/lp/aboard/media/lp-hero-1080.webm", "video/webm"],
    ["/lp/aboard/media/lp-hero-1080.mp4", "video/mp4"],
    ["/lp/aboard/media/lp-gift-hero.jpg", "image/jpeg"],
    ["/lp/aboard/media/lp-gift-howto.jpg", "image/jpeg"],
  ];

  for (const [path, type] of media) {
    const res = handleAsset(path);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe(type);
    // Real bytes on disk, not an empty placeholder.
    expect((await res!.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  }

  // Nothing on the page may still point at the mockup share space. A live page
  // people are paid to visit cannot break when a mockup gets tidied up.
  const html = await handleAsset("/lp/aboard")!.text();
  const css = await handleAsset("/lp/aboard/style.css")!.text();
  expect(html).not.toContain("share.gate1.dev");
  expect(css).not.toContain("share.gate1.dev");

  // The page asks for these under the PUBLIC path. The Worker rewrites
  // /gift-offer/media/<file> onto the upstream /lp/aboard/media/<file> served above.
  for (const [path] of media) {
    expect(html + css).toContain(path.replace("/lp/aboard/", "/gift-offer/"));
  }
});

test("video is served in byte ranges, which Safari needs before it will play", async () => {
  const path = "/lp/aboard/media/lp-hero-1080.mp4";
  const ranged = (value: string) =>
    handleAsset(path, new Request("https://x/", { headers: { Range: value } }))!;

  const full = handleAsset(path)!;
  const size = (await full.arrayBuffer()).byteLength;
  expect(full.headers.get("Accept-Ranges")).toBe("bytes");

  const first = ranged("bytes=0-1023");
  expect(first.status).toBe(206);
  expect(first.headers.get("Content-Range")).toBe(`bytes 0-1023/${size}`);
  expect((await first.arrayBuffer()).byteLength).toBe(1024);

  // An open ended range is the one Safari actually opens with.
  const open = ranged("bytes=0-");
  expect(open.status).toBe(206);
  expect(open.headers.get("Content-Range")).toBe(`bytes 0-${size - 1}/${size}`);
  expect((await open.arrayBuffer()).byteLength).toBe(size);

  const mid = ranged("bytes=1000-1999");
  expect(mid.status).toBe(206);
  expect(mid.headers.get("Content-Range")).toBe(`bytes 1000-1999/${size}`);

  // An end past the file is legal and clamps. Refusing it breaks players that ask
  // for a fixed size chunk near the end of the file.
  const over = ranged(`bytes=${size - 10}-${size + 5000}`);
  expect(over.status).toBe(206);
  expect(over.headers.get("Content-Range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
  expect((await over.arrayBuffer()).byteLength).toBe(10);
});

test("a suffix range means the LAST n bytes, not the first n", async () => {
  const path = "/lp/aboard/media/lp-hero-1080.mp4";
  const ranged = (value: string) =>
    handleAsset(path, new Request("https://x/", { headers: { Range: value } }))!;
  const size = (await handleAsset(path)!.arrayBuffer()).byteLength;
  const whole = new Uint8Array(await handleAsset(path)!.arrayBuffer());

  const suffix = ranged("bytes=-500");
  expect(suffix.status).toBe(206);
  expect(suffix.headers.get("Content-Range")).toBe(`bytes ${size - 500}-${size - 1}/${size}`);

  const bytes = new Uint8Array(await suffix.arrayBuffer());
  expect(bytes.byteLength).toBe(500);
  // Really the tail of the file, not the head wearing the right Content-Range.
  expect(Array.from(bytes)).toEqual(Array.from(whole.slice(size - 500)));

  // A suffix longer than the file is the whole file, not an error.
  const everything = ranged(`bytes=-${size + 1000}`);
  expect(everything.status).toBe(206);
  expect(everything.headers.get("Content-Range")).toBe(`bytes 0-${size - 1}/${size}`);
  expect((await everything.arrayBuffer()).byteLength).toBe(size);
});

test("unsatisfiable ranges are refused with 416", async () => {
  const path = "/lp/aboard/media/lp-hero-1080.mp4";
  const ranged = (value: string) =>
    handleAsset(path, new Request("https://x/", { headers: { Range: value } }))!;
  const size = (await handleAsset(path)!.arrayBuffer()).byteLength;

  for (const bad of [
    `bytes=${size + 10}-`, // starts past the end
    `bytes=${size}-`, // first byte past the end
    "bytes=-0", // zero length suffix
    "bytes=-", // no start and no suffix
    "bytes=500-100", // backwards
  ]) {
    const res = ranged(bad);
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${size}`);
  }

  // Malformed headers are ignored rather than refused: the whole file comes back.
  for (const junk of ["items=0-10", "bytes=abc-def", "nonsense"]) {
    const res = ranged(junk);
    expect(res.status).toBe(200);
  }
});

test("everything the browser asks for uses the public /gift-offer path", async () => {
  // The public URL is https://nordicpirates.com/gift-offer. The Cloudflare Worker
  // rewrites /gift-offer and /gift-offer/* onto this service's /lp/aboard and
  // /lp/aboard/*. So the upstream routes stay /lp/aboard (asserted elsewhere) while
  // every path the page EMITS has to be /gift-offer, or the browser asks the shop
  // for something it does not have.
  const html = await handleAsset("/lp/aboard")!.text();
  const js = await handleAsset("/lp/aboard/page.js")!.text();
  const css = await handleAsset("/lp/aboard/style.css")!.text();

  expect(html).toContain('<link rel="canonical" href="https://nordicpirates.com/gift-offer">');
  expect(html).toContain('href="/gift-offer/style.css"');
  expect(html).toContain('src="/gift-offer/page.js"');
  expect(js).toContain('fetch("/gift-offer/claim"');
  expect(css).toContain("/gift-offer/media/lp-hero-poster.jpg");

  // Not one upstream path may leak into anything the browser receives, comments
  // included. page.js and offer.js are both shipped to the browser.
  const offerJs = await handleAsset("/lp/aboard/offer.js")!.text();
  for (const delivered of [html, js, css, offerJs]) {
    expect(delivered).not.toContain("/lp/aboard");
  }

  // page.js imports "./offer.js" relative to itself. Served to the browser as
  // /gift-offer/page.js, that resolves to /gift-offer/offer.js, which the Worker
  // rewrites back to the upstream module. A path with a directory in it would not.
  expect(js).toContain('from "./offer.js"');
});

test("the upstream routes this service answers on are still /lp/aboard", () => {
  // The Worker rewrites onto these. They must not move.
  for (const path of [
    "/lp/aboard",
    "/lp/aboard/style.css",
    "/lp/aboard/page.js",
    "/lp/aboard/offer.js",
    "/lp/aboard/media/lp-hero-1080.mp4",
  ]) {
    expect(handleAsset(path)?.status).toBe(200);
  }

  // The public paths are the Worker's job, not this service's. It does not answer
  // on them, which is why the rewrite has to be in place before the URL goes live.
  expect(handleAsset("/gift-offer")).toBeNull();
  expect(handleAsset("/gift-offer/style.css")).toBeNull();
});

test("the page never hardcodes a discount code in its markup", async () => {
  const html = await handleAsset("/lp/aboard")!.text();
  expect(html).not.toContain("KRAKEN-A7F2");
  expect(html).not.toContain("FULLHOLD-B642");
});

test("German base game: code KRAKEN-A7F2 and the German variant in the cart", async () => {
  const res = await claim({ email: "crew@example.com", offer: "base-kraken", edition: "de" });
  expect(res.status).toBe(200);

  const data = await res.json();
  expect(data.state).toBe("code");
  expect(data.code).toBe("KRAKEN-A7F2");
  expect(data.cartUrl).toContain(BASE_DE);
  expect(data.cartUrl).toContain(KRAKEN);
  expect(data.cartUrl).toContain("discount=KRAKEN-A7F2");
});

test("German base game is issued from any country, not just outside Europe", async () => {
  const res = await claim(
    { email: "crew@example.com", offer: "base-kraken", edition: "de" },
    { country: "SE" }
  );
  expect((await res.json()).state).toBe("code");
});

test("English base game inside Europe is blocked, and offered the BIG BOX instead", async () => {
  const res = await claim(
    { email: "swede@example.com", offer: "base-kraken", edition: "en" },
    { country: "SE" }
  );
  expect(res.status).toBe(200);

  const data = await res.json();
  expect(data.state).toBe("blocked");
  // The BIG BOX is what this state sells, so it must carry the BIG BOX code.
  // A base code on a BIG BOX cart buys the visitor nothing.
  expect(data.code).toBe("FULLHOLD-B642");
  expect(data.cartUrl).toContain(BIGBOX_EN);
  expect(data.cartUrl).toContain(KRAKEN);
  expect(data.cartUrl).toContain(COINS);
  expect(data.cartUrl).toContain("discount=FULLHOLD-B642");
});

test("every EU, EEA and GB country blocks the English base game", async () => {
  for (const country of ["DE", "FR", "IT", "ES", "PL", "IE", "NO", "IS", "LI", "GB"]) {
    const res = await claim(
      { email: "eu@example.com", offer: "base-coins", edition: "en" },
      { country }
    );
    expect((await res.json()).state).toBe("blocked");
  }
});

test("an authenticated claim uses the forwarded visitor and ignores the proxy hop", async () => {
  const blocked = await claimWithHeaders(
    { email: "proxied@example.com", offer: "base-kraken", edition: "en" },
    {
      "x-lp-proxy-secret": PROXY_SECRET,
      "x-visitor-country": "SE",
      "x-visitor-ip": "203.0.113.5",
      // What the Worker hop itself looks like: a US edge, nowhere near the visitor.
      // It must have no say at all.
      "CF-IPCountry": "US",
      "CF-Connecting-IP": "198.51.100.200",
    }
  );
  expect((await blocked.json()).state).toBe("blocked");
  expect(storedLines().find((l) => l.email === "proxied@example.com")?.country).toBe("SE");

  // And the other way round: a real visitor outside Europe behind a European hop.
  const allowed = await claimWithHeaders(
    { email: "proxied-us@example.com", offer: "base-kraken", edition: "en" },
    {
      "x-lp-proxy-secret": PROXY_SECRET,
      "x-visitor-country": "US",
      "x-visitor-ip": "203.0.113.6",
      "CF-IPCountry": "SE",
    }
  );
  expect((await allowed.json()).state).toBe("code");
  expect(storedLines().find((l) => l.email === "proxied-us@example.com")?.country).toBe("US");
});

test("a claim without the proxy secret is refused with 403 and stores nothing", async () => {
  // The claim endpoint is reachable only through the Worker. Anything that cannot
  // prove it came from there is refused outright, rather than quietly falling back
  // to headers that whoever reached this origin can set for themselves.
  const before = storedLines().length;

  const attempts: Record<string, Record<string, string>> = {
    "no headers at all": {},
    "forged visitor headers, no secret": {
      "x-visitor-country": "US",
      "x-visitor-ip": "203.0.113.50",
    },
    "CF headers only, straight at the origin": {
      "CF-IPCountry": "SE",
      "CF-Connecting-IP": "203.0.113.7",
    },
    "wrong secret": { "x-lp-proxy-secret": "not-the-secret", "x-visitor-country": "US" },
    "secret one char short": { "x-lp-proxy-secret": PROXY_SECRET.slice(0, -1) },
    "secret with one char too many": { "x-lp-proxy-secret": PROXY_SECRET + "x" },
    "right length, wrong value": { "x-lp-proxy-secret": "x".repeat(PROXY_SECRET.length) },
    "empty secret": { "x-lp-proxy-secret": "" },
  };

  for (const [name, headers] of Object.entries(attempts)) {
    const res = await claimWithHeaders(
      { email: `unauth-${name.replace(/\W+/g, "-")}@example.com`, offer: "base-kraken", edition: "de" },
      headers
    );
    expect(res.status).toBe(403);

    // No code leaves the building, and nothing is written down.
    const body = await res.json();
    expect(body.code).toBeUndefined();
    expect(body.cartUrl).toBeUndefined();
  }

  expect(storedLines().length).toBe(before);
});

test("each authenticated visitor gets their own rate limit budget", async () => {
  // Every request through the Worker shares one CF-Connecting-IP. If that were what
  // we counted, one busy visitor would lock out everybody else behind the proxy.
  const hop = { "x-lp-proxy-secret": PROXY_SECRET, "CF-Connecting-IP": "198.51.100.201" };
  for (let i = 0; i < 12; i++) {
    const res = await claimWithHeaders(
      { email: "crowd@example.com", offer: "base-kraken", edition: "de" },
      { ...hop, "x-visitor-ip": `203.0.113.${200 + i}` }
    );
    expect(res.status).toBe(200);
  }
});

test("static assets stay public: only the claim endpoint needs the secret", () => {
  // The page itself has to load for anyone the Worker sends, before any request
  // with a body happens. Locking the assets down would break the page.
  for (const path of ["/lp/aboard", "/lp/aboard/style.css", "/lp/aboard/page.js"]) {
    expect(handleAsset(path)?.status).toBe(200);
  }
});

test("English base game outside Europe is fine", async () => {
  for (const country of ["US", "AU", "CA", "CH", "JP"]) {
    const res = await claim(
      { email: "away@example.com", offer: "base-kraken", edition: "en" },
      { country }
    );
    const data = await res.json();
    expect(data.state).toBe("code");
    expect(data.code).toBe("KRAKEN-A7F2");
    expect(data.cartUrl).toContain(BASE_EN);
  }
});

test("the BIG BOX is never blocked, it ships from Europe", async () => {
  const res = await claim(
    { email: "big@example.com", offer: "bigbox-both", edition: "en" },
    { country: "SE" }
  );
  const data = await res.json();
  expect(data.state).toBe("code");
  expect(data.code).toBe("FULLHOLD-B642");
  expect(data.cartUrl).toContain("discount=FULLHOLD-B642");
});

test("the BIG BOX carries both gifts and its own code, never the base code", async () => {
  const res = await claim({ email: "big@example.com", offer: "bigbox-both", edition: "de" });
  const data = await res.json();
  expect(data.cartUrl).toContain(KRAKEN);
  expect(data.cartUrl).toContain(COINS);
  expect(data.cartUrl).not.toContain("KRAKEN-A7F2");
});

test("a base cart never carries the BIG BOX code", async () => {
  for (const offer of ["base-kraken", "base-coins"]) {
    const res = await claim({ email: "base@example.com", offer, edition: "it" });
    const data = await res.json();
    expect(data.code).toBe("KRAKEN-A7F2");
    expect(data.cartUrl).not.toContain("FULLHOLD-B642");
  }
});

test("English cart links never use the French variant, the bug in the mockup", async () => {
  for (const offer of ["base-kraken", "base-coins", "bigbox-both"]) {
    const res = await claim({ email: "en@example.com", offer, edition: "en" }, { country: "US" });
    const data = await res.json();
    expect(data.cartUrl).not.toContain(BASE_FR);
  }
  // And the blocked path, which swaps in a cart of its own.
  const blocked = await claim(
    { email: "en@example.com", offer: "base-kraken", edition: "en" },
    { country: "SE" }
  );
  expect((await blocked.json()).cartUrl).not.toContain(BASE_FR);
});

test("each edition gets its own variant", async () => {
  const expected: Record<string, string> = {
    en: BASE_EN,
    fr: BASE_FR,
    es: "51542813475163",
    it: "51542813507931",
    de: BASE_DE,
  };
  for (const [edition, variant] of Object.entries(expected)) {
    const res = await claim(
      { email: "each@example.com", offer: "base-kraken", edition },
      { country: "US" }
    );
    expect((await res.json()).cartUrl).toContain(variant);
  }
});

test("bad email is rejected with 400", async () => {
  for (const email of ["", "nope", "no@domain", "two words@example.com"]) {
    const res = await claim({ email, offer: "base-kraken", edition: "de" });
    expect(res.status).toBe(400);
  }
});

test("an email longer than 254 characters is rejected with 400", async () => {
  // RFC 5321 caps a forward path at 254. 254 is fine, 255 is not.
  const local = (n: number) => "a".repeat(n) + "@example.com";
  const atLimit = local(254 - "@example.com".length);
  expect(atLimit.length).toBe(254);

  const ok = await claim({ email: atLimit, offer: "base-kraken", edition: "de" });
  expect(ok.status).toBe(200);

  const tooLong = local(255 - "@example.com".length);
  expect(tooLong.length).toBe(255);

  const rejected = await claim({ email: tooLong, offer: "base-kraken", edition: "de" });
  expect(rejected.status).toBe(400);

  // And nothing that long reached the store.
  expect(storedLines().some((l) => l.email === tooLong)).toBe(false);
});

test("unknown offer or edition is rejected with 400", async () => {
  const badOffer = await claim({ email: "a@example.com", offer: "free-stuff", edition: "de" });
  expect(badOffer.status).toBe(400);

  const badEdition = await claim({ email: "a@example.com", offer: "base-kraken", edition: "sv" });
  expect(badEdition.status).toBe(400);
});

test("a filled honeypot is rejected and never stored", async () => {
  const before = storedLines().length;
  const res = await claim({
    email: "bot@example.com",
    offer: "base-kraken",
    edition: "de",
    company: "Acme Ltd",
  });
  expect(res.status).toBe(400);
  expect(storedLines().length).toBe(before);
});

test("any action field is refused, and no action is ever stored", async () => {
  // This endpoint cannot prove who owns the address it is given. Anyone could post
  // a victim's address, so it must not accept an instruction about their mailing
  // list. rejoin included: there is no such thing here any more.
  const before = storedLines().length;

  for (const action of ["rejoin", "unsubscribe-everyone", "", "REJOIN"]) {
    const res = await claim({ email: "back@example.com", offer: "base-coins", edition: "fr", action });
    expect(res.status).toBe(400);
  }

  expect(storedLines().length).toBe(before);

  // And a clean submission never grows an action field of its own.
  const ok = await claim({ email: "clean@example.com", offer: "base-coins", edition: "fr" });
  expect(ok.status).toBe(200);

  const entry = storedLines().find((l) => l.email === "clean@example.com");
  expect(entry).toBeDefined();
  expect("action" in entry!).toBe(false);
});

test("the page has no rejoin control and no rejoin state", async () => {
  const html = await handleAsset("/lp/aboard")!.text();
  const js = await handleAsset("/lp/aboard/page.js")!.text();
  for (const source of [html, js]) {
    expect(source).not.toContain("rejoin");
    expect(source).not.toContain("Come back aboard");
  }
  expect(html).not.toContain("tpl-rejoin");
});

test("every submission lands in the JSONL store, blocked ones included", async () => {
  await claim({ email: "stored@example.com", offer: "base-kraken", edition: "de" }, { country: "DE" });
  await claim({ email: "blocked@example.com", offer: "base-kraken", edition: "en" }, { country: "SE" });

  const lines = storedLines();

  const ok = lines.find((l) => l.email === "stored@example.com");
  expect(ok).toBeDefined();
  expect(ok!.state).toBe("code");
  expect(ok!.offer).toBe("base-kraken");
  expect(ok!.edition).toBe("de");
  expect(ok!.country).toBe("DE");
  expect(ok!.code).toBe("KRAKEN-A7F2");
  expect(typeof ok!.ts).toBe("string");

  const blocked = lines.find((l) => l.email === "blocked@example.com");
  expect(blocked).toBeDefined();
  expect(blocked!.state).toBe("blocked");
  // Issued the base code, shown the BIG BOX one. The emailer needs both.
  expect(blocked!.code).toBe("KRAKEN-A7F2");
  expect(blocked!.shownCode).toBe("FULLHOLD-B642");
});

test("logs carry no PII, no codes and no raw payload, only the event and what happened", async () => {
  // Container logs get shipped around and tailed in chat. The protected JSONL file
  // is the record; a log line is only ever a trace of what the endpoint did.
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  const email = "very.private.person@secret-domain.example";
  try {
    // A success, a blocked one, a bad email, a honeypot hit, a refused action, and
    // one that never got past the door.
    await claim({ email, offer: "base-kraken", edition: "de" }, { country: "DE", ip: "203.0.113.99" });
    await claim({ email, offer: "base-kraken", edition: "en" }, { country: "SE", ip: "203.0.113.98" });
    await claim({ email: "not-an-email-at-all", offer: "base-kraken", edition: "de" });
    await claim({ email, offer: "base-kraken", edition: "de", company: "SpamCorp AB" });
    await claim({ email, offer: "base-kraken", edition: "de", action: "rejoin" });
    await claimWithHeaders({ email, offer: "base-kraken", edition: "de" }, {
      "x-visitor-ip": "203.0.113.97",
      "x-lp-proxy-secret": "a-guess-at-the-secret",
    });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  expect(lines.length).toBeGreaterThan(0);
  const logged = lines.join("\n");

  for (const secret of [
    email,
    "secret-domain.example",
    "not-an-email-at-all",
    "SpamCorp AB", // honeypot value
    "KRAKEN-A7F2", // discount codes
    "FULLHOLD-B642",
    "203.0.113.99", // visitor IPs
    "203.0.113.98",
    "203.0.113.97",
    "a-guess-at-the-secret", // never echo a presented secret
    PROXY_SECRET,
    "DE", // country. Checked case sensitively below, "DE" never appears alone.
    "SE",
  ]) {
    expect(logged).not.toContain(secret);
  }

  // What it SHOULD say: the event id and the non-sensitive shape of the request.
  expect(logged).toContain("claim stored event=");
  expect(logged).toContain("offer=base-kraken");
  expect(logged).toContain("reason=honeypot");
  expect(logged).toContain("reason=invalid-fields fields=email");
  expect(logged).toContain("reason=action-not-accepted");
  expect(logged).toContain("reason=unauthenticated");
});

test("the event id ties a log line back to its stored row", async () => {
  const res = await claim({ email: "traced@example.com", offer: "base-kraken", edition: "de" });
  expect(res.status).toBe(200);

  const entry = storedLines().find((l) => l.email === "traced@example.com");
  expect(entry).toBeDefined();
  expect(entry!.event).toMatch(/^[0-9a-f]{12}$/);
});

test("a failed write returns 503 with no code, instead of a code nobody recorded", async () => {
  // The page tells people the code is also on its way to their inbox. The only thing
  // that makes that true is this file - the emailer reads it and nothing else. So a
  // code on screen with no row in the file is a promise already broken.
  //
  // Make the store unwritable for real rather than mocking the failure away.
  const before = storedLines();
  expect(existsSync(SIGNUPS)).toBe(true);
  chmodSync(SIGNUPS, 0o444);

  let res: Response;
  try {
    res = await claim({ email: "unwritable@example.com", offer: "base-kraken", edition: "de" });
  } finally {
    chmodSync(SIGNUPS, 0o644);
  }

  expect(res!.status).toBe(503);

  const body = await res!.json();
  expect(body.code).toBeUndefined();
  expect(body.cartUrl).toBeUndefined();
  expect(body.state).toBeUndefined();
  expect(typeof body.error).toBe("string");

  // Nothing was written, and the file is intact.
  expect(storedLines().length).toBe(before.length);
  expect(storedLines().some((l) => l.email === "unwritable@example.com")).toBe(false);

  // And the endpoint recovers once the disk does.
  const after = await claim({ email: "recovered@example.com", offer: "base-kraken", edition: "de" });
  expect(after.status).toBe(200);
  expect((await after.json()).code).toBe("KRAKEN-A7F2");
});

test("the JSONL store is not reachable over HTTP", () => {
  expect(handleAsset("/lp/aboard/lp-aboard-signups.jsonl")).toBeNull();
  expect(handleAsset("/lp/aboard/../state/lp-aboard-signups.jsonl")).toBeNull();
  expect(handleAsset("/lp/aboard/state.json")).toBeNull();
  expect(handleAsset("/lp/anything-else")).toBeNull();
});

test("the rate limit stops the eleventh try from one IP", async () => {
  const ip = "203.0.113.77";
  for (let i = 0; i < 10; i++) {
    const res = await claim({ email: "spam@example.com", offer: "base-kraken", edition: "de" }, { ip });
    expect(res.status).toBe(200);
  }
  const res = await claim({ email: "spam@example.com", offer: "base-kraken", edition: "de" }, { ip });
  expect(res.status).toBe(429);
});

test("a plain form post works too, not only JSON", async () => {
  const form = new FormData();
  form.set("email", "form@example.com");
  form.set("offer", "base-kraken");
  form.set("edition", "it");

  const res = await handleClaim(
    new Request("https://nordicpirates.com/lp/aboard/claim", {
      method: "POST",
      headers: { "x-lp-proxy-secret": PROXY_SECRET, "x-visitor-ip": "198.51.100.9" },
      body: form,
    })
  );
  expect(res.status).toBe(200);
  expect((await res.json()).state).toBe("code");
});
