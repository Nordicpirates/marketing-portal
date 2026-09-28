// The language switch and the code shown before the cart, on the real gift page.
// What each test pins and why: docs/TESTS-GIFT-I18N.md

import { afterAll, test, expect } from "bun:test";
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
  restorePageGlobals,
  type Page,
} from "./page-harness.ts";
// The page's own offer table, so no test owns a copy of its variants. docs/TESTS-GIFT-I18N.md
import { cartItems } from "../lib/offer.js";

// Put back the browser globals loadPage replaced, so later files see Bun's own.
afterAll(restorePageGlobals);

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

/** The Back button onto a frozen page: pageshow with persisted set, nothing re-run.
 * docs/TESTS-GIFT-I18N.md, restoreFromCache */
function restoreFromCache(page: Page) {
  const event = new page.window.Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  page.window.dispatchEvent(event);
}

test("the English table and the markup say the same thing", async () => {
  // The page must read right before, and without, the language module. docs/TESTS-GIFT-I18N.md
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

  // Named, because the key comparison above would pass if it vanished from all five.
  // docs/TESTS-GIFT-I18N.md, all five tables hold exactly the same keys
  for (const lang of LANGUAGES) {
    expect(
      COPY[lang]["state.cartFailedRetired.lead"],
      `"${lang}" has no lead for the cart-failure panel that has lost its cart link`
    ).toBeDefined();
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
    const found = source.match(/[\u2013\u2014]/g);
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

  // The reviews are quoted as their authors wrote them, in English. docs/TESTS-GIFT-I18N.md
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
  // Taking the English BIG BOX moves the whole page onto it, words included.
  // docs/TESTS-GIFT-I18N.md, the BIG BOX branch
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
  // The emailed code is the Base Game one, so no table may promise the inbox here.
  // docs/TESTS-GIFT-I18N.md, no language promises the inbox
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

// One test per language: each waits out the real hold, and a loop would time out.
// docs/TESTS-GIFT-I18N.md, the code before the cart
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

// A tap during the wait for the claim's answer must not split the page from the cart.
// docs/TESTS-GIFT-I18N.md, the hold during a claim

test(
  "a chip tapped while the claim is in flight cannot move the box that goes in the cart",
  async () => {
    const page = await loadPage({ body: codeAnswer });
    const release = page.holdClaim();

    await page.submit();

    // The request is out with the English edition on it, and nothing has come back.
    expect(page.calls[0].body.edition).toBe("en");
    expect(page.cartCalls()).toEqual([]);

    // Dispatched whatever the chip's state: this is where the page ends up.
    // docs/TESTS-GIFT-I18N.md, a chip tapped while the claim is in flight
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
  // The radios are the whole language control below 720px, so they are held too.
  // docs/TESTS-GIFT-I18N.md, the edition radios are held with the chips
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

// What is left once the wait is done: a retry, a fallback link, a page Back returns.
// docs/TESTS-GIFT-I18N.md, what is left after the wait

test(
  "a retry carts the box the page is showing, whatever was pressed in between",
  async () => {
    // The cart failed and the retry is on screen. A tap on a chip lands somewhere in
    // between, and then they press it.
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

    // Dispatched whatever the chip's state, as in the race test. docs/TESTS-GIFT-I18N.md
    await page.click(chip(page, "fr"));

    page.cartStatus = () => 200;
    await page.click(page.document.querySelector("#result [data-retry]"));
    await page.navigated();

    // The same claim as the race test: whatever box the page is showing is the box in
    // the cart. Read off the page rather than assumed, so it holds in either direction.
    const shown = LANGUAGES.find((lang) => page.document.getElementById(`ed-${lang}`).checked);
    const add = page.cartCalls().filter((c) => c.url === "/cart/add.js").pop();
    expect(add.body.items[0].id).toBe(BASE_VARIANT_FOR[shown!]);

    // Kept on the claim's box: only the endpoint knows where the visitor is.
    // docs/TESTS-GIFT-I18N.md, a retry carts the box the page is showing
    expect(shown).toBe("en");
    expect(page.document.documentElement.getAttribute("lang")).toBe("en");
  },
  REDIRECT_TEST_MS
);

test("the fallback cart link on that panel is the box on screen too", async () => {
  // A link pointing at another edition is the same disagreement with a slower fuse.
  // docs/TESTS-GIFT-I18N.md, the fallback cart link on that panel
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
    // Back hands over the frozen document, so a hold left standing is never released.
    // docs/TESTS-GIFT-I18N.md, a page restored from the browser's cache
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
    // Each attempt takes the hold over rather than stacking another on top.
    // docs/TESTS-GIFT-I18N.md, a page that took two tries
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
  // Leaving through the fallback link freezes the page too, hold and all.
  // docs/TESTS-GIFT-I18N.md, a page left through the fallback cart link
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
    // A retry and a movable picker can now disagree; the claim wins, visibly.
    // docs/TESTS-GIFT-I18N.md, a retry pressed on a page that came back
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

    // Whatever the page shows is what is in the cart, against the page's own table.
    // docs/TESTS-GIFT-I18N.md, a retry pressed on a page that came back
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
    // Starting a fresh claim abandons the old attempt, and its hold must go with it.
    // docs/TESTS-GIFT-I18N.md, a visitor who started over
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
    // A departure that resolves nothing leaves the hold standing, rightly.
    // docs/TESTS-GIFT-I18N.md, a page left with a retry still waiting
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

// Older roads to a cart, same shape: a cart built from a choice no longer on screen.
// docs/TESTS-GIFT-I18N.md, the roads to a cart

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

/** Every href to a shop cart, read as the attribute over the whole document.
 * An href, not a listener, is what a browser follows. docs/TESTS-GIFT-I18N.md, cartRoads */
function cartRoads(page: Page): string[] {
  return Array.from(page.document.querySelectorAll("a[href]"))
    .map((a: any) => a.getAttribute("href"))
    .filter((href: string) => href.includes("/cart/"));
}

/** The variants one cart url would put in the cart, in the order it names them. */
function cartedBy(href: string): string[] {
  const path = href.split("?")[0].split("/cart/")[1] || "";
  return path.split(",").map((item) => item.split(":")[0]);
}

/** No road to a cart disagrees with the page; no road at all also passes.
 * docs/TESTS-GIFT-I18N.md, noRoadDisagrees */
function noRoadDisagrees(page: Page) {
  const shown = showing(page);
  const wanted = cartItems(shown.offer, shown.edition)!.items.map((item) => item.id);
  for (const href of cartRoads(page)) {
    expect(
      cartedBy(href),
      `the page shows ${shown.offer}/${shown.edition}, and this road carts ${href}`
    ).toEqual(wanted);
  }
}

// Either control leaves the claim; the gift repaints nothing, so it is tested too.
// docs/TESTS-GIFT-I18N.md, LEAVING_THE_CLAIM
const LEAVING_THE_CLAIM: {
  control: string;
  move: (page: Page) => unknown;
  shows: { offer: string; edition: string };
}[] = [
  {
    control: "the language",
    move: (page) => page.click(chip(page, "fr")),
    shows: { offer: "base-kraken", edition: "fr" },
  },
  {
    control: "the gift",
    move: (page) => tapOffer(page, "o-bigbox"),
    shows: { offer: "bigbox-both", edition: "en" },
  },
];

for (const { control, move, shows } of LEAVING_THE_CLAIM) {
  test(`a cart link the page has moved away from stops being a road out: ${control}`, async () => {
    // no_redirect leaves the link and both controls free; the href is what disagrees.
    // docs/TESTS-GIFT-I18N.md, LEAVING_THE_CLAIM
    const page = await loadPage({ body: codeAnswer }, DEMO);
    await page.submit();

    expect(cartRoads(page).length, "the panel starts with a cart link on it").toBe(1);
    noRoadDisagrees(page);

    await move(page);

    expect(showing(page)).toEqual(shows);
    noRoadDisagrees(page);
    expect(cartRoads(page), "the link the page has left behind is gone").toEqual([]);
  });
}

test(
  "the fallback link is retired when the page leaves the claim, and the retry is not",
  async () => {
    // Setup: out through the fallback link and Back, so both controls are free.
    // docs/TESTS-GIFT-I18N.md, the fallback link is retired
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

    page.document
      .querySelector("#result [data-cart]")
      .dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    restoreFromCache(page);

    // Both halves of the claim move, and neither of them through the link.
    await page.click(chip(page, "fr"));
    tapOffer(page, "o-bigbox");
    expect(showing(page)).toEqual({ offer: "bigbox-both", edition: "fr" });

    noRoadDisagrees(page);
    // The line under the link says one click loads both items. With no link to click it
    // describes nothing, so it goes with it.
    expect(page.document.querySelector("#result [data-cart-note]")).toBeNull();

    // The retry stays: it goes back through the page, so it cannot disagree.
    // docs/TESTS-GIFT-I18N.md, the fallback link is retired
    const retry = page.document.querySelector("#result [data-retry]");
    expect(retry, "the retry is still there").not.toBeNull();

    page.cartStatus = () => 200;
    await page.click(retry);
    await page.navigated();

    const add = page.cartCalls().filter((c) => c.url === "/cart/add.js").pop();
    expect(showing(page)).toEqual({ offer: "base-kraken", edition: "en" });
    expect(add.body.items).toEqual(cartItems("base-kraken", "en")!.items);
  },
  REDIRECT_TEST_MS
);

// Each language's own word for the button, so the test reads the visitor's sentence.
// docs/TESTS-GIFT-I18N.md, the panel stops naming a cart button
const CART_BUTTON: Record<string, string> = {
  en: "cart button",
  de: "Warenkorb Button",
};

for (const lang of Object.keys(CART_BUTTON)) {
  test(`the panel stops naming a cart button it no longer has: ${lang.toUpperCase()}`, async () => {
    // A lead pointing at a link that is gone describes the panel wrongly.
    // docs/TESTS-GIFT-I18N.md, the panel stops naming a cart button
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

    await page.click(chip(page, lang));
    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

    // With the link still on the panel, the lead is the one that names it, unchanged.
    expect(on(page, "#result [data-lead]")).toBe(say(lang, "state.cartFailed.lead"));
    expect(on(page, "#result [data-lead]")).toContain(CART_BUTTON[lang]);

    // Out through the link and back; awaited, since the panel redraws a task later.
    // docs/TESTS-GIFT-I18N.md, the panel stops naming a cart button
    await page.click(page.document.querySelector("#result [data-cart]"));
    restoreFromCache(page);

    // The gift, not the language: it repaints nothing, so the lead is fixed at retirement.
    // docs/TESTS-GIFT-I18N.md, the panel stops naming a cart button
    tapOffer(page, "o-bigbox");
    expect(page.document.querySelector("#result [data-cart]"), "the link is gone").toBeNull();

    expect(on(page, "#result [data-lead]")).toBe(say(lang, "state.cartFailedRetired.lead"));
    expect(on(page, "#result [data-lead]")).not.toContain(CART_BUTTON[lang]);

    // Everything else about the panel is untouched: the code is the one thing that must
    // not be lost, and the retry is the road out that still works.
    expect(on(page, "#result h3")).toBe(say(lang, "state.cartFailed.title"));
    expect(on(page, "#result [data-code]")).toBe(CODE_BASE);
    expect(page.document.querySelector("#result [data-retry]")).not.toBeNull();
  });
}

test("the fallback cart link carts the box the page is showing, even after Back", async () => {
  // After Back with nothing moved, the fallback link carts what the page shows.
  // docs/TESTS-GIFT-I18N.md, the fallback cart link carts the box the page is showing
  const page = await loadPage({ body: codeAnswer });
  page.cartStatus = (path) => (path === "/cart/add.js" ? 500 : 200);

  await page.submit();
  await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

  page.document
    .querySelector("#result [data-cart]")
    .dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  restoreFromCache(page);

  // Theirs again, and the link is still on the panel they came back to.
  expect(chip(page, "fr").disabled).toBe(false);
  expect(page.document.getElementById("o-bigbox").disabled).toBe(false);

  const link = page.document.querySelector("#result [data-cart]");
  const href = link.getAttribute("href");
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
  noRoadDisagrees(page);
});

test("taking the BIG BOX moves the page onto the box it carts", async () => {
  // The BIG BOX on offer is the English one, so taking it moves picker and language.
  // docs/TESTS-GIFT-I18N.md, taking the BIG BOX
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
    // The gift radio moved while the blocked panel was deciding; the claim wins, visibly.
    // docs/TESTS-GIFT-I18N.md, taking a European edition moves the gift back
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

test("switching language after a code is issued rewords the panel and retires its cart link", async () => {
  // The link is never re-pointed, and an unchanged href on a changed page is retired.
  // docs/TESTS-GIFT-I18N.md, switching language after a code is issued
  const page = await loadPage({ body: codeAnswer }, DEMO);
  await page.submit();

  const before = page.document.querySelector("#result [data-cart]").getAttribute("href");
  expect(before).toContain(BASE_VARIANT_FOR.en);

  await page.click(chip(page, "de"));

  expect(on(page, "#result h3")).toBe(say("de", "state.code.title"));
  expect(on(page, "#result [data-code]")).toBe(CODE_BASE);
  expect(cartRoads(page), "the link is gone rather than re-pointed at the picker").toEqual([]);
});
