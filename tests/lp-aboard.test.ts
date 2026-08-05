// Tests for the /lp/aboard gift offer page and its claim endpoint.
//
// These check what the page SHOULD do, straight off the acceptance criteria in
// issue #2 and the two spec updates: the right variant per edition, the right code
// per offer, and the English base game refused inside Europe.
//
// The handlers are called directly with Request objects. No server is started.

import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the store at a scratch dir BEFORE the module reads it at import time.
const TEST_STATE = mkdtempSync(join(tmpdir(), "lp-aboard-test-"));
process.env.STATE_DIR = TEST_STATE;

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

/** One claim POST. Each caller passes its own IP so the rate limit stays out of the way. */
function claim(
  body: Record<string, string>,
  opts: { country?: string; ip?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": opts.ip || `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
  };
  if (opts.country) headers["CF-IPCountry"] = opts.country;
  return handleClaim(
    new Request("https://nordicpirates.com/lp/aboard/claim", {
      method: "POST",
      headers,
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

test("rejoin is accepted and recorded as such", async () => {
  const res = await claim({
    email: "back@example.com",
    offer: "base-coins",
    edition: "fr",
    action: "rejoin",
  });
  expect(res.status).toBe(200);
  expect((await res.json()).state).toBe("code");

  const entry = storedLines().find((l) => l.email === "back@example.com");
  expect(entry?.action).toBe("rejoin");
});

test("an unknown action is rejected rather than quietly ignored", async () => {
  const res = await claim({
    email: "a@example.com",
    offer: "base-kraken",
    edition: "de",
    action: "unsubscribe-everyone",
  });
  expect(res.status).toBe(400);
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
      headers: { "CF-Connecting-IP": "198.51.100.9" },
      body: form,
    })
  );
  expect(res.status).toBe(200);
  expect((await res.json()).state).toBe("code");
});
