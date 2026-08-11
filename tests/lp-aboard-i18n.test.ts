// Tests for issue #14: the five nav chips are a real language switch, and a successful
// claim shows the visitor their code before it takes them to the cart.
//
// Straight off Lucas's two asks. All five chips translate every visitor-facing string,
// including the states the page renders after the form comes back, and the same click
// picks the physical edition we ship. What happens to the CART afterwards is
// lp-aboard-cart.test.ts; the page harness both files drive is tests/page-harness.ts.

import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "fs";
import { join } from "path";
import {
  loadPage,
  selectOffer,
  blockedAnswer,
  codeAnswer,
  COPY,
  LANGUAGES,
  CODE_VISIBLE_MS,
  REDIRECT_TEST_MS,
  CODE_BASE,
  CODE_BIGBOX,
  HTML,
  say,
  tapOffer,
  type Page,
} from "./page-harness.ts";
// The page's own table of what an offer plus an edition puts in a cart. Asserting
// against it rather than against a copy is what keeps this test about the pairing the
// page is supposed to keep, instead of about variant ids it would then own a second
// copy of.
import { cartItems } from "../lib/offer.js";

const DEMO = "https://nordicpirates.com/gift-offer?no_redirect=1";

const REPO = join(import.meta.dir, "..");
const PAGE_JS = readFileSync(join(REPO, "public", "lp-aboard.js"), "utf8");

const flat = (value: string) => value.replace(/\s+/g, " ").trim();

/** The markup as it is served, with no page module having touched it. */
function markup() {
  const window = new Window({ url: "https://nordicpirates.com/gift-offer" });
  window.document.write(HTML);
  return window.document;
}

/** Every element carrying a key, the ones inside <template> included. */
function keyed(doc: any, attribute: string): any[] {
  const roots = [doc, ...Array.from(doc.querySelectorAll("template")).map((t: any) => t.content)];
  return roots.flatMap((root: any) => Array.from(root.querySelectorAll(`[${attribute}]`)));
}

function chip(page: Page, lang: string): any {
  const button = page.document.querySelector(`.np-lang[data-lang="${lang}"]`);
  if (!button) throw new Error(`no language chip for "${lang}"`);
  return button;
}

const on = (page: Page, selector: string) => page.document.querySelector(selector).textContent.trim();

/**
 * The Back button onto a page the browser had frozen.
 *
 * Nothing re-runs: the document comes back exactly as it was when it left, which is why
 * anything the flow left behind on it is still there. The one thing a browser does say
 * is this event, with `persisted` set to mark the document as the frozen one rather than
 * a fresh load. The page listens for none of it, and these tests are how that stays a
 * choice: what it hands back has to be usable before anybody presses Back.
 *
 * `persisted` is defined by hand because this DOM has no PageTransitionEvent of its own.
 */
function restoreFromCache(page: Page) {
  const event = new page.window.Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  page.window.dispatchEvent(event);
}

test("the English table and the markup say the same thing", async () => {
  // The page has to read correctly before the language module runs, and if it never
  // runs. That only holds while these two agree, so changing the copy in one and not
  // the other is a failure rather than a silent drift.
  const doc = markup();

  for (const el of keyed(doc, "data-i18n")) {
    const key = el.getAttribute("data-i18n");
    expect(COPY.en[key], `markup uses "${key}", which the English table does not have`).toBeDefined();
    expect(flat(el.textContent), `markup and English table disagree on "${key}"`).toBe(COPY.en[key]);
  }

  for (const [attribute, target] of [
    ["data-i18n-alt", "alt"],
    ["data-i18n-aria-label", "aria-label"],
  ]) {
    for (const el of keyed(doc, attribute)) {
      const key = el.getAttribute(attribute);
      expect(COPY.en[key], `markup uses "${key}", which the English table does not have`).toBeDefined();
      expect(flat(el.getAttribute(target)), `markup and English table disagree on "${key}"`).toBe(
        COPY.en[key]
      );
    }
  }
});

test("all five tables hold exactly the same keys", async () => {
  const english = Object.keys(COPY.en).sort();
  expect(LANGUAGES).toEqual(["en", "de", "it", "fr", "es"]);

  for (const lang of LANGUAGES) {
    expect(Object.keys(COPY[lang]).sort(), `"${lang}" does not match the English key list`).toEqual(
      english
    );
    for (const key of english) {
      expect(COPY[lang][key].length, `"${lang}" has nothing for "${key}"`).toBeGreaterThan(0);
    }
  }
});

test("no copy is written and then never shown", async () => {
  // A key nothing asks for is copy somebody wrote for a screen that does not exist.
  const doc = markup();
  const used = new Set<string>();
  for (const attribute of ["data-i18n", "data-i18n-alt", "data-i18n-aria-label"]) {
    for (const el of keyed(doc, attribute)) used.add(el.getAttribute(attribute));
  }

  for (const key of Object.keys(COPY.en)) {
    if (used.has(key)) continue;
    // The rest are written by page.js: the heading over the email field, the sticky
    // button, and every line the result states are given rather than born with.
    expect(PAGE_JS.includes(`"${key}"`), `nothing on the page ever shows "${key}"`).toBe(true);
  }
});

test("no copy anywhere uses an en dash or an em dash", async () => {
  const files = [
    "public/lp-aboard.html",
    "public/lp-aboard.js",
    "public/lp-aboard-cart.js",
    "public/lp-aboard.css",
    "public/lp-aboard-i18n.js",
    ...LANGUAGES.map((lang) => `public/lp-aboard-i18n-${lang}.js`),
  ];

  for (const file of files) {
    const source = readFileSync(join(REPO, file), "utf8");
    const found = source.match(/[–—]/g);
    expect(found, `${file} uses ${found?.join(" ")}`).toBeNull();
  }
});

test("each chip translates the whole page and picks the matching edition", async () => {
  for (const lang of LANGUAGES) {
    const page = await loadPage({ body: codeAnswer });
    await page.click(chip(page, lang));

    // The document itself, which is what a screen reader picks its voice from.
    expect(page.document.documentElement.getAttribute("lang")).toBe(lang);
    expect(page.document.title).toBe(say(lang, "meta.title"));

    // A line from every part of the page, top to bottom.
    expect(on(page, "h1")).toBe(say(lang, "hero.title"));
    expect(on(page, ".hero-cta")).toBe(say(lang, "hero.cta"));
    expect(on(page, ".np-nav-cta")).toBe(say(lang, "nav.cta"));
    expect(on(page, '.np-links a[href="#how-to-play"]')).toBe(say(lang, "nav.howToPlay"));
    expect(on(page, ".how-card h3")).toBe(say(lang, "how.1.title"));
    expect(on(page, ".ship-title")).toBe(say(lang, "ship.title"));
    expect(on(page, ".offer-head h2")).toBe(say(lang, "offer.title"));
    expect(on(page, ".pick-title")).toBe(say(lang, "pick.kraken.title"));
    expect(on(page, "#claim-title")).toBe(say(lang, "claim.title.kraken"));
    expect(on(page, "#submit-btn")).toBe(say(lang, "claim.submit"));
    expect(on(page, ".states-idle")).toBe(say(lang, "claim.idle"));
    expect(on(page, "footer .wrap span:nth-child(2)")).toBe(say(lang, "footer.tagline"));

    // Copy a visitor hears rather than reads.
    expect(page.document.querySelector(".showcase img").getAttribute("alt")).toBe(
      say(lang, "showcase.alt")
    );
    expect(page.document.querySelector(".np-langs").getAttribute("aria-label")).toBe(
      say(lang, "nav.aria.langs")
    );

    // The physical box, chosen by the same click.
    expect(page.document.getElementById(`ed-${lang}`).checked).toBe(true);
    for (const other of LANGUAGES.filter((l) => l !== lang)) {
      expect(page.document.getElementById(`ed-${other}`).checked).toBe(false);
    }
    expect(chip(page, lang).className).toContain("is-on");
    expect(chip(page, lang === "en" ? "de" : "en").className).not.toContain("is-on");
  }
});

test("switching away from English leaves no English behind", async () => {
  const page = await loadPage({ body: codeAnswer });
  await page.click(chip(page, "es"));

  const body = flat(page.document.body.textContent);
  for (const gone of [
    "We will not have a better offer than this.",
    "Choose your gift",
    "Get my code",
    "Sent from a warehouse near you",
    "Your code appears here once you send the form.",
  ]) {
    expect(body).not.toContain(gone);
  }

  // The community reviews are quotes from named people who wrote them in English, and
  // the line above them says they are unedited. Translating those would make that
  // sentence false, so they stay as their authors wrote them.
  expect(body).toContain("Excellent game with a lot of replay value!");
  expect(flat(page.document.querySelector(".voices-head > p").textContent)).toBe(
    say("es", "reviews.note")
  );
});

test("the edition picker switches the page too, and comes back", async () => {
  // The chip and the radio are two ends of one choice, so either end moves both.
  const page = await loadPage({ body: codeAnswer });

  const italian = page.document.getElementById("ed-it");
  italian.checked = true;
  italian.dispatchEvent(new page.window.Event("change", { bubbles: true }));

  expect(on(page, "h1")).toBe(say("it", "hero.title"));
  expect(chip(page, "it").className).toContain("is-on");
  expect(page.document.documentElement.getAttribute("lang")).toBe("it");

  await page.click(chip(page, "en"));
  expect(on(page, "h1")).toBe(say("en", "hero.title"));
  expect(page.document.getElementById("ed-en").checked).toBe(true);
});

test("the sticky button and the claim heading follow the language", async () => {
  const page = await loadPage({ body: codeAnswer });
  const button = page.document.getElementById("gift-jump");

  page.observer.show();
  expect(button.textContent).toBe(say("en", "sticky.pick"));

  await page.click(chip(page, "fr"));
  expect(button.textContent).toBe(say("fr", "sticky.pick"));

  selectOffer(page, "o-bigbox");
  expect(button.textContent).toBe(say("fr", "sticky.continue"));
  expect(on(page, "#claim-title")).toBe(say("fr", "claim.title.bigbox"));

  await page.click(chip(page, "de"));
  expect(button.textContent).toBe(say("de", "sticky.continue"));
  expect(on(page, "#claim-title")).toBe(say("de", "claim.title.bigbox"));
});

test("the form posts the edition the chip selected", async () => {
  const page = await loadPage({ body: codeAnswer }, DEMO);
  await page.click(chip(page, "it"));
  await page.submit();

  expect(page.calls[0].body).toEqual({
    email: "crew@example.com",
    offer: "base-kraken",
    edition: "it",
    company: "",
  });
});

test("the code state comes out in the language the visitor is reading", async () => {
  for (const lang of LANGUAGES) {
    const page = await loadPage({ body: codeAnswer }, DEMO);
    await page.click(chip(page, lang));
    await page.submit();

    expect(on(page, "#result h3")).toBe(say(lang, "state.code.title"));
    expect(on(page, "#result [data-lead]")).toBe(say(lang, "state.code.lead"));
    expect(on(page, "#result [data-copy]")).toBe(say(lang, "state.copy"));
    expect(on(page, "#result [data-cart]")).toBe(say(lang, "state.cart.label"));
    expect(on(page, "#result [data-cart-note]")).toBe(say(lang, "state.cart.note"));
    expect(on(page, "#result [data-code]")).toBe(CODE_BASE);
  }
});

test("the BIG BOX cart button says three items, in every language", async () => {
  for (const lang of LANGUAGES) {
    const page = await loadPage({ body: { state: "code", code: CODE_BIGBOX } }, DEMO);
    await page.click(chip(page, lang));
    selectOffer(page, "o-bigbox");
    await page.submit();

    expect(on(page, "#result [data-cart]")).toBe(say(lang, "state.cart.bigbox.label"));
    expect(on(page, "#result [data-cart-note]")).toBe(say(lang, "state.cart.bigbox.note"));
  }
});

test("a refused claim explains itself in the language the visitor is reading", async () => {
  for (const lang of LANGUAGES) {
    const limited = await loadPage({ status: 429, body: { error: "Too many attempts" } });
    await limited.click(chip(limited, lang));
    await limited.submit();

    expect(on(limited, "#result h3")).toBe(say(lang, "state.error.title"));
    expect(on(limited, "#result [data-message]")).toBe(say(lang, "error.rateLimited"));
    expect(on(limited, "#result .state-note")).toBe(say(lang, "state.error.note"));
    // The endpoint's own English wording is for the log, not for the visitor.
    expect(limited.text()).not.toContain("Too many attempts");

    const broken = await loadPage({ status: 500, body: { error: "nope" } });
    await broken.click(chip(broken, lang));
    await broken.submit();
    expect(on(broken, "#result [data-message]")).toBe(say(lang, "error.generic"));
  }
});

test("the blocked flow reads in whichever language the chip is on", async () => {
  // Blocked only ever answers the English base game, so a blocked visitor arrives on
  // the English page. They can still switch, and the panel has to follow them.
  const page = await loadPage({ body: blockedAnswer }, DEMO);
  await page.submit();
  expect(on(page, "#result h3")).toBe(say("en", "state.blocked.title"));

  for (const lang of LANGUAGES) {
    await page.click(chip(page, lang));

    expect(on(page, "#result h3")).toBe(say(lang, "state.blocked.title"));
    expect(on(page, '#result [data-choice="edition"] b')).toBe(say(lang, "state.blocked.editionTitle"));
    expect(on(page, '#result [data-choice="package"] b')).toBe(say(lang, "state.blocked.packageTitle"));

    // Still no code in either direction until they have answered.
    expect(page.document.querySelector("#result [data-code]")).toBeNull();
  }
});

test("the edition list keeps its box names while the page around it translates", async () => {
  const page = await loadPage({ body: blockedAnswer }, DEMO);
  await page.submit();
  await page.click(page.document.querySelector('#result [data-choice="edition"]'));

  for (const lang of LANGUAGES) {
    await page.click(chip(page, lang));

    expect(on(page, "#result h3")).toBe(say(lang, "state.editions.title"));
    expect(on(page, "#result .choice-back")).toBe(say(lang, "state.editions.back"));

    // The names printed on the boxes, which are the same in every language, and never
    // the edition we have just said we cannot ship.
    const editions = Array.from(page.document.querySelectorAll("#result [data-edition]"));
    expect(editions.map((b: any) => b.textContent.trim())).toEqual([
      "Deutsch",
      "Français",
      "Español",
      "Italiano",
    ]);
    expect(page.document.querySelector('#result [data-edition="en"]')).toBeNull();
  }
});

test("taking a European edition switches the page into that language", async () => {
  const page = await loadPage({ body: blockedAnswer }, DEMO);
  await page.submit();
  await page.click(page.document.querySelector('#result [data-choice="edition"]'));
  await page.click(page.document.querySelector('#result [data-edition="fr"]'));

  // The box they asked for and the words they are reading are the same choice.
  expect(page.document.getElementById("ed-fr").checked).toBe(true);
  expect(page.document.documentElement.getAttribute("lang")).toBe("fr");
  expect(on(page, "h1")).toBe(say("fr", "hero.title"));
  expect(on(page, "#result h3")).toBe(say("fr", "state.edition.title"));
  expect(on(page, "#result [data-lead]")).toBe(say("fr", "state.edition.lead"));
  expect(on(page, "#result [data-code]")).toBe(CODE_BASE);
});

test("the BIG BOX branch moves the page onto the box it sells", async () => {
  // This choice is called "Give me the BIG BOX in English" and there is no other edition
  // of it on offer, so taking it moves the whole page onto that box: the picker, the
  // chips and the words with them. It used to leave a visitor reading German while the
  // cart filled with the English BIG BOX, which is the disagreement this page exists to
  // make impossible. Losing the German words is what that costs, and it is the honest
  // way round: the page they are looking at is the box they are buying.
  const page = await loadPage({ body: blockedAnswer }, DEMO);
  await page.submit();
  await page.click(chip(page, "de"));

  // The panel they are answering is still theirs to read. Only the answer moves the page.
  expect(on(page, "#result h3")).toBe(say("de", "state.blocked.title"));

  await page.click(page.document.querySelector('#result [data-choice="package"]'));

  expect(page.document.documentElement.getAttribute("lang")).toBe("en");
  expect(on(page, "h1")).toBe(say("en", "hero.title"));
  expect(on(page, "#result h3")).toBe(say("en", "state.bigbox.title"));
  expect(on(page, "#result [data-lead]")).toBe(say("en", "state.bigbox.lead"));
  expect(on(page, "#result [data-code]")).toBe(CODE_BIGBOX);
  expect(page.text()).not.toContain("inbox");
});

test("no language promises the inbox on the BIG BOX branch", async () => {
  // The code we email this visitor is the Base Game one they were issued, not this one,
  // so no table may say otherwise. Read off the copy rather than off a rendered panel:
  // that branch only ever renders in English now, and the promise has to be absent from
  // all five. Each word is the one that language's own code state uses for the inbox.
  const INBOX: Record<string, string> = {
    en: "inbox",
    de: "Postfach",
    it: "casella",
    fr: "boîte mail",
    es: "bandeja",
  };

  for (const lang of LANGUAGES) {
    expect(say(lang, "state.code.lead"), `"${INBOX[lang]}" is not how ${lang} says inbox`).toContain(
      INBOX[lang]
    );
    expect(
      say(lang, "state.bigbox.lead"),
      `the ${lang} BIG BOX lead promises an inbox we are not filling`
    ).not.toContain(INBOX[lang]);
  }
});

test("a cart that will not build says so in the language on screen", async () => {
  const page = await loadPage({ body: codeAnswer });
  page.cartStatus = (path) => (path === "/cart/add.js" ? 422 : 200);

  await page.click(chip(page, "es"));
  await page.submit();
  await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

  expect(on(page, "#result h3")).toBe(say("es", "state.cartFailed.title"));
  expect(on(page, "#result [data-lead]")).toBe(say("es", "state.cartFailed.lead"));
  expect(on(page, "#result [data-retry]")).toBe(say("es", "state.retry"));
  expect(on(page, "#result [data-code]")).toBe(CODE_BASE);
  expect(page.navigations).toEqual([]);
});

// Both halves of Lucas's first ask at once: the code is visible and readable, and the
// screen that shows it is in the language the visitor was reading.
//
// One test per language rather than a loop over both. Each of these waits out the real
// CODE_VISIBLE_MS hold, so a loop of two spends over 5000ms in a single test body and
// trips bun's default per-test timeout. The hold is the thing under test and does not
// get shortened for the test's convenience; the test is split so each one waits once,
// and says how long it is allowed to take.
const BASE_VARIANT_FOR: Record<string, string> = {
  en: "51542813409627",
  fr: "51542813442395",
};

/** The three gift radios, so a test can read which box the page is showing. */
const GIFTS = [
  { id: "o-kraken", value: "base-kraken" },
  { id: "o-coins", value: "base-coins" },
  { id: "o-bigbox", value: "bigbox-both" },
];

for (const lang of ["en", "fr"]) {
  test(
    `the code is on screen, in ${lang.toUpperCase()}, before the redirect`,
    async () => {
      const page = await loadPage({ body: codeAnswer });
      await page.click(chip(page, lang));

      const started = Date.now();
      await page.submit();

      expect(on(page, "#result h3")).toBe(say(lang, "state.sending.title"));
      expect(on(page, "#result [data-code]")).toBe(CODE_BASE);
      expect(flat(page.text())).toContain(say(lang, "state.sending.lead"));
      expect(page.navigations).toEqual([]);

      await page.navigated();
      expect(Date.now() - started).toBeGreaterThanOrEqual(CODE_VISIBLE_MS);

      // And it went to the cart for the edition that chip selected.
      const add = page.cartCalls().find((c) => c.url === "/cart/add.js");
      expect(add.body.items[0].id).toBe(BASE_VARIANT_FOR[lang]);
    },
    REDIRECT_TEST_MS
  );
}

// A claim is posted with the edition that was chosen when the button was pressed, and
// the answer comes back some unknown time later. Everything below is about that gap:
// the box the visitor is looking at and the box being put in their cart are one choice,
// and a tap that lands during the wait must not be able to pull them apart.

test(
  "a chip tapped while the claim is in flight cannot move the box that goes in the cart",
  async () => {
    const page = await loadPage({ body: codeAnswer });
    const release = page.holdClaim();

    await page.submit();

    // The request is out with the English edition on it, and nothing has come back.
    expect(page.calls[0].body.edition).toBe("en");
    expect(page.cartCalls()).toEqual([]);

    // The visitor taps FR while the answer is still in the air. The tap is dispatched
    // whatever state the chip is in: what this test is about is where the page ends up,
    // not which mechanism keeps it there.
    await page.click(chip(page, "fr"));

    release();
    await page.navigated();

    // Whatever box the page ends up showing, that is the box in the cart. This is the
    // whole claim: the two cannot be read apart, in either direction.
    const shown = LANGUAGES.find((lang) => page.document.getElementById(`ed-${lang}`).checked);
    const add = page.cartCalls().find((c) => c.url === "/cart/add.js");
    expect(add.body.items[0].id).toBe(BASE_VARIANT_FOR[shown!]);

    // And the box that is kept is the one the claim was made for, in the words to match.
    expect(shown).toBe("en");
    expect(page.document.documentElement.getAttribute("lang")).toBe("en");
    expect(on(page, "h1")).toBe(say("en", "hero.title"));
  },
  REDIRECT_TEST_MS
);

test("the edition radios are held with the chips, and both are handed back", async () => {
  // The chips are not on screen at all below 720px, so the radios are the whole
  // language control on a phone. Holding one end and not the other would leave the
  // race exactly where it was for most visitors.
  const page = await loadPage({ body: codeAnswer }, DEMO);
  const release = page.holdClaim();

  await page.submit();

  // Visibly held rather than dead: a disabled radio is a control the visitor can see
  // is not theirs for the moment, which is what the stylesheet dims.
  const french = page.document.getElementById("ed-fr");
  expect(french.disabled).toBe(true);
  expect(chip(page, "fr").disabled).toBe(true);

  // Dispatched anyway, because a held control that still acted on the event would be
  // the same bug wearing a disabled attribute.
  french.dispatchEvent(new page.window.Event("change", { bubbles: true }));

  expect(page.document.documentElement.getAttribute("lang")).toBe("en");
  expect(on(page, "h1")).toBe(say("en", "hero.title"));

  release();
  await page.until(() => !!page.document.querySelector("#result [data-code]"), "the code");

  // The answer has landed and the visitor has something to act on, so the choice is
  // theirs again rather than staying dead for the rest of the page's life.
  expect(french.disabled).toBe(false);
  expect(chip(page, "fr").disabled).toBe(false);
});

test("a claim that is refused hands the language back", async () => {
  // Nothing was issued, so there is nothing to protect. Leaving it held would strand a
  // visitor who wants to read the page in their own language and try again.
  const page = await loadPage({ status: 429, body: { error: "Too many attempts" } });
  await page.submit();

  expect(chip(page, "de").disabled).toBe(false);
  expect(page.document.getElementById("ed-de").disabled).toBe(false);
  // The gift with them, since it goes into the same request and is held for the same
  // reason: a visitor who has to try again may want to try again for another box.
  expect(page.document.getElementById("o-bigbox").disabled).toBe(false);

  await page.click(chip(page, "de"));
  expect(on(page, "#result [data-message]")).toBe(say("de", "error.rateLimited"));
});

// The hold above covers the wait for the answer. These four are about what is left over
// once that wait is done: a cart that would not build leaves a retry on screen and a
// fallback link beside it, both of them made for a decision the visitor took a minute
// ago, and a cart that DID build leaves a page the browser can hand back.

test(
  "a retry carts the box the page is showing, whatever was pressed in between",
  async () => {
    // The cart failed and the retry is on screen. A tap on a chip lands somewhere in
    // between, and then they press it.
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

    // Dispatched whatever state the chip is in, for the same reason as the race test
    // above: this is about where the page ends up, not about which mechanism keeps it
    // there.
    await page.click(chip(page, "fr"));

    page.cartStatus = () => 200;
    await page.click(page.document.querySelector("#result [data-retry]"));
    await page.navigated();

    // The same claim as the race test: whatever box the page is showing is the box in
    // the cart. Read off the page rather than assumed, so it holds in either direction.
    const shown = LANGUAGES.find((lang) => page.document.getElementById(`ed-${lang}`).checked);
    const add = page.cartCalls().filter((c) => c.url === "/cart/add.js").pop();
    expect(add.body.items[0].id).toBe(BASE_VARIANT_FOR[shown!]);

    // And the box that is kept is the one the claim was made for. It has to be that one
    // rather than the chip's: only the endpoint knows where the visitor is, and it
    // agreed to ship THIS edition to them.
    expect(shown).toBe("en");
    expect(page.document.documentElement.getAttribute("lang")).toBe("en");
  },
  REDIRECT_TEST_MS
);

test("the fallback cart link on that panel is the box on screen too", async () => {
  // The other way off the same panel. It carries the variant in its url, so a link
  // pointing at another edition than the page is the same disagreement with a slower
  // fuse: the visitor clicks it a minute later and buys a box the page never showed.
  const page = await loadPage({ body: codeAnswer });
  page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

  await page.submit();
  await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");
  await page.click(chip(page, "fr"));

  const shown = LANGUAGES.find((lang) => page.document.getElementById(`ed-${lang}`).checked);
  expect(page.document.querySelector("#result [data-cart]").href).toContain(BASE_VARIANT_FOR[shown!]);

  // Visibly refused rather than swallowed, which is how the chip says the choice is not
  // the visitor's while a cart for it is still waiting to be built.
  expect(chip(page, "fr").disabled).toBe(true);
});

test(
  "a page restored from the browser's cache comes back usable",
  async () => {
    // The cart was built and the page took the visitor to it. They press Back, and the
    // browser hands them the frozen document rather than running any of this again. So
    // whatever was still held when the page left is still held now, and there is nothing
    // running that could ever release it.
    const page = await loadPage({ body: codeAnswer });
    await page.submit();
    await page.navigated();

    restoreFromCache(page);

    const french = page.document.getElementById("ed-fr");
    expect(french.disabled).toBe(false);
    expect(chip(page, "fr").disabled).toBe(false);

    // Alive rather than merely enabled, which is what the visitor tries next.
    await page.click(chip(page, "fr"));
    expect(page.document.documentElement.getAttribute("lang")).toBe("fr");
    expect(french.checked).toBe(true);
    expect(on(page, "h1")).toBe(say("fr", "hero.title"));
  },
  REDIRECT_TEST_MS
);

test(
  "a page that took two tries to build its cart comes back usable as well",
  async () => {
    // Each attempt takes the hold over from the one before it rather than stacking a new
    // one on top of it. Stacked, they would not all be let go by the time the page
    // navigates, and a visitor who had to press the button twice would be the one who
    // presses Back onto the dead page above.
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

    const first = page.document.querySelector("#result [data-retry]");
    await page.click(first);
    // The panel is drawn again for the second failure, so the button is a new one. That
    // is what says the attempt finished, rather than only that its request went out.
    await page.until(
      () => page.document.querySelector("#result [data-retry]") !== first,
      "the second attempt to fail"
    );

    page.cartStatus = () => 200;
    await page.click(page.document.querySelector("#result [data-retry]"));
    await page.navigated();

    restoreFromCache(page);
    expect(chip(page, "fr").disabled).toBe(false);
    expect(page.document.getElementById("ed-fr").disabled).toBe(false);
  },
  REDIRECT_TEST_MS
);

test("a page left through the fallback cart link comes back usable", async () => {
  // The other way off the cart-failed panel. The retry stays on this page, but the link
  // beside it goes to the shop, and the browser freezes this document on the way out
  // exactly as it does for the redirect. A hold still standing at that moment is a hold
  // that comes back standing, on a page with nothing left running to release it.
  const page = await loadPage({ body: codeAnswer });
  page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

  await page.submit();
  await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

  // Held while the panel is only being looked at, which is what the sibling test above
  // pins down. This test is about the moment they leave through the link.
  expect(chip(page, "fr").disabled).toBe(true);

  const link = page.document.querySelector("#result [data-cart]");
  const followed = link.dispatchEvent(
    new page.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })
  );
  // Let go of on the way out, not instead of going out: the link is still the visitor's
  // road to the shop, and swallowing the click would cost them the cart it points at.
  expect(followed).toBe(true);

  restoreFromCache(page);

  const french = page.document.getElementById("ed-fr");
  expect(french.disabled).toBe(false);
  expect(chip(page, "fr").disabled).toBe(false);
  expect(page.document.getElementById("o-bigbox").disabled).toBe(false);

  // Alive rather than merely enabled, which is what the visitor tries next.
  await page.click(chip(page, "fr"));
  expect(page.document.documentElement.getAttribute("lang")).toBe("fr");
  expect(french.checked).toBe(true);
  expect(on(page, "h1")).toBe(say("fr", "hero.title"));
});

test(
  "a retry pressed on a page that came back carts the box the claim was made for",
  async () => {
    // What the test above buys, and what it costs. Handing the choice back at the link
    // means the page that comes back carries a retry AND a picker the visitor can move,
    // so the two can be pointed at different boxes for the first time since the claim was
    // made. Pressing the button then has to answer the question this whole page is built
    // around: which of the two wins.
    //
    // The claim does. It is the box the endpoint agreed it could ship to this visitor,
    // and it is what both codes were issued against, so the page comes back to it rather
    // than the cart following the chip. Same answer takeEdition already gives on the
    // blocked road, and the visitor sees it: the words and the picker move back together
    // before the cart is built.
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

    page.document
      .querySelector("#result [data-cart]")
      .dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    restoreFromCache(page);

    // Both controls moved while the page was theirs again.
    await page.click(chip(page, "fr"));
    tapOffer(page, "o-bigbox");
    expect(page.document.documentElement.getAttribute("lang")).toBe("fr");

    page.cartStatus = () => 200;
    await page.click(page.document.querySelector("#result [data-retry]"));
    await page.navigated();

    // The claim every other test on this page makes, at the one moment it was still
    // possible to break it: whatever the page ends up showing is what is in the cart.
    // Both halves read off the page, and against the page's own offer table rather than
    // a copy of it, so this says what the cart holds and not what I expected it to.
    const shown = LANGUAGES.filter((lang) => page.document.getElementById(`ed-${lang}`).checked);
    const gift = GIFTS.filter((g) => page.document.getElementById(g.id).checked);
    expect([shown.length, gift.length]).toEqual([1, 1]);

    const add = page.cartCalls().filter((c) => c.url === "/cart/add.js").pop();
    expect(add.body.items).toEqual(cartItems(gift[0].value, shown[0])!.items);

    // And the box it came back to is the claim's, in the words to match.
    expect(shown[0]).toBe("en");
    expect(gift[0].value).toBe("base-kraken");
    expect(page.document.documentElement.getAttribute("lang")).toBe("en");
    expect(on(page, "h1")).toBe(say("en", "hero.title"));
  },
  REDIRECT_TEST_MS
);

test(
  "a page whose visitor started over instead of retrying comes back usable",
  async () => {
    // The third road off the cart-failed panel, and the only one that is not a button on
    // it. The form is still up the page and the submit button is live again, so a visitor
    // can walk away from the attempt waiting for them by starting a fresh claim. The
    // abandoned attempt's hold has to go with it: left behind, it rides the new claim's
    // page into the browser's cache and Back hands back a page nobody can use.
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");
    // The button really is theirs to press again, which is what makes this road real.
    expect(page.document.getElementById("submit-btn").disabled).toBe(false);

    page.cartStatus = () => 200;
    await page.submit();
    await page.navigated();

    restoreFromCache(page);
    expect(chip(page, "fr").disabled).toBe(false);
    expect(page.document.getElementById("ed-fr").disabled).toBe(false);
    expect(page.document.getElementById("o-bigbox").disabled).toBe(false);
  },
  REDIRECT_TEST_MS
);

test(
  "a page left with a retry still waiting comes back held, and the retry still works",
  async () => {
    // The departure that is nobody's exit in particular: the privacy link under the
    // submit button, the nav, a bookmark. Nothing about the attempt is resolved by any of
    // those, so unlike the fallback cart link they hand nothing back, and the hold is
    // right to be standing again on the way in. This is the case a blanket release on
    // pageshow would break rather than fix.
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

    restoreFromCache(page);

    // Still held, because the decision it is guarding is still the one on screen.
    expect(chip(page, "fr").disabled).toBe(true);
    expect(page.document.getElementById("o-bigbox").disabled).toBe(true);

    // And held is not stuck: the button that was waiting for them still works, and
    // taking it hands everything back on the way to the cart.
    page.cartStatus = () => 200;
    await page.click(page.document.querySelector("#result [data-retry]"));
    await page.navigated();

    expect(chip(page, "fr").disabled).toBe(false);
    expect(page.document.getElementById("o-bigbox").disabled).toBe(false);
  },
  REDIRECT_TEST_MS
);

// Three more roads to a cart, all of them older than the language work: the stale
// fallback link comes from 96a5c04, both blocked mismatches from 8d23637. They are the
// same shape as everything above - a cart built from a choice the visitor is no longer
// looking at - and they are the reason the page now moves itself onto the box it is
// about to cart instead of each road remembering to hold the controls still.
//
// Each one reads both halves off the page and compares them against the page's own offer
// table, so it says what the cart holds rather than what I expected it to.

/** Whatever the page is showing right now, as one gift and one edition. */
function showing(page: Page): { offer: string; edition: string } {
  const editions = LANGUAGES.filter((lang) => page.document.getElementById(`ed-${lang}`).checked);
  const gifts = GIFTS.filter((g) => page.document.getElementById(g.id).checked);
  expect([editions.length, gifts.length], "the page shows one gift and one edition").toEqual([1, 1]);
  return { offer: gifts[0].value, edition: editions[0] };
}

/** Assert that a cart link holds exactly what the page is showing. */
function linkMatchesPage(page: Page, href: string) {
  const shown = showing(page);
  for (const item of cartItems(shown.offer, shown.edition)!.items) {
    expect(href, `the page shows ${shown.offer}/${shown.edition}, the link carts ${href}`).toContain(
      item.id
    );
  }
  return shown;
}

test("the fallback cart link carts the box the page is showing, even after Back", async () => {
  // The cart would not build, the visitor left through the fallback link, and Back handed
  // them the frozen page: the hold went out of the door with them, so both controls are
  // theirs again with that panel still on screen. The retry beside the link answers that
  // by bringing the page back to the box it is about to cart. The link is the other road
  // off the same panel and has to answer it the same way, because its href was ruled on
  // by the endpoint and must not follow the picker: a European re-aiming themselves at
  // the English Base Game is the one combination the endpoint refuses.
  const page = await loadPage({ body: codeAnswer });
  page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

  await page.submit();
  await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

  page.document
    .querySelector("#result [data-cart]")
    .dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  restoreFromCache(page);

  // Both controls moved while the page was theirs again.
  await page.click(chip(page, "fr"));
  tapOffer(page, "o-bigbox");
  expect(page.document.documentElement.getAttribute("lang")).toBe("fr");

  // And then they take the link that was still sitting there.
  const link = page.document.querySelector("#result [data-cart]");
  const href = link.href;
  const followed = link.dispatchEvent(
    new page.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })
  );
  // Let go of on the way out, not instead of going out: the link is still their road to
  // the shop, and swallowing the click would cost them the cart it points at.
  expect(followed).toBe(true);

  // The link the visitor followed and the page they left behind hold the same box.
  const shown = linkMatchesPage(page, href);
  expect(shown).toEqual({ offer: "base-kraken", edition: "en" });
  expect(page.document.documentElement.getAttribute("lang")).toBe("en");
});

test("taking the BIG BOX moves the page onto the box it carts", async () => {
  // The blocked panel is read in whatever language the visitor switched to, and the BIG
  // BOX it offers is the English one: "Give me the BIG BOX in English". So taking it has
  // to move the picker and the language as well as the cart. Left behind, the page shows
  // the German base game while the cart holds the English BIG BOX.
  const page = await loadPage({ body: blockedAnswer }, DEMO);
  await page.submit();
  await page.click(chip(page, "de"));

  await page.click(page.document.querySelector('#result [data-choice="package"]'));

  const shown = linkMatchesPage(page, page.document.querySelector("#result [data-cart]").href);
  expect(shown).toEqual({ offer: "bigbox-both", edition: "en" });
  expect(page.document.documentElement.getAttribute("lang")).toBe("en");
});

test(
  "taking a European edition moves the gift back to the one that was claimed",
  async () => {
    // Issue #17, driven the way that issue reproduces it: a real cart rather than the
    // demo link. The gift radios are the visitor's again while they answer this panel,
    // because the panel is asking about editions and the gift is not part of the
    // question, so the picker can be pointing at another box by the time they choose.
    //
    // The claim wins. The code they were issued is the Base Game rule and the BIG BOX is
    // a different one, so the page comes back to the base game rather than the cart
    // following the box they tapped. That issue weighed holding the gift dim throughout
    // against reading it off the page at the end; this is neither. The gift moves back at
    // the moment they commit, visibly, which is the same answer every other road gets.
    const page = await loadPage({ body: blockedAnswer });
    await page.submit();
    tapOffer(page, "o-bigbox");

    await page.click(page.document.querySelector('#result [data-choice="edition"]'));
    await page.click(page.document.querySelector('#result [data-edition="de"]'));
    await page.navigated();

    const shown = showing(page);
    const add = page.cartCalls().filter((c) => c.url === "/cart/add.js").pop();
    expect(add.body.items).toEqual(cartItems(shown.offer, shown.edition)!.items);

    expect(shown).toEqual({ offer: "base-kraken", edition: "de" });
    expect(page.document.documentElement.getAttribute("lang")).toBe("de");
  },
  REDIRECT_TEST_MS
);

test("switching language after a code is issued rewords the panel and nothing else", async () => {
  // The claim is already made. The words follow the visitor; the cart the code was
  // issued against does not move under them.
  const page = await loadPage({ body: codeAnswer }, DEMO);
  await page.submit();

  const before = page.document.querySelector("#result [data-cart]").href;
  await page.click(chip(page, "de"));

  expect(on(page, "#result h3")).toBe(say("de", "state.code.title"));
  expect(on(page, "#result [data-code]")).toBe(CODE_BASE);
  expect(page.document.querySelector("#result [data-cart]").href).toBe(before);
});
