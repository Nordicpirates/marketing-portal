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
  type Page,
} from "./page-harness.ts";

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

test("the BIG BOX branch reads in the language on screen and never claims the inbox", async () => {
  const page = await loadPage({ body: blockedAnswer }, DEMO);
  await page.submit();
  await page.click(chip(page, "de"));
  await page.click(page.document.querySelector('#result [data-choice="package"]'));

  expect(on(page, "#result h3")).toBe(say("de", "state.bigbox.title"));
  expect(on(page, "#result [data-lead]")).toBe(say("de", "state.bigbox.lead"));
  expect(on(page, "#result [data-code]")).toBe(CODE_BIGBOX);

  // The code we email this visitor is the Base Game one, not this one, so no branch of
  // this screen may say otherwise. "Postfach" is the German word for the inbox.
  expect(page.text()).not.toContain("Postfach");
  expect(page.text()).not.toContain("inbox");
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

  await page.click(chip(page, "de"));
  expect(on(page, "#result [data-message]")).toBe(say("de", "error.rateLimited"));
});

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
