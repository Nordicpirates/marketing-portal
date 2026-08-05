// Tests for what the gift page DOES in a browser, straight off the acceptance
// criteria in issue #6: the picker sends you to the email field, the sticky button
// routes and then gets out of the way, and a blocked visitor is asked which cart they
// want before any code appears.
//
// The real public/lp-aboard.html and public/lp-aboard.js are loaded into a DOM and
// driven with real events. Nothing here re-implements the page: the only things faked
// are the four browser pieces a test process does not have, and each of them is faked
// so the test can DRIVE it (the claim answer, what is on screen, where the page
// scrolled), not so the page can avoid it.
//
// About the module copy: page.js imports "./offer.js", which the browser resolves
// against /gift-offer/page.js and the server answers from lib/offer.js. On disk those
// two files are not siblings, so each test writes the page module to a scratch file
// with that one import pointing at the real lib/offer.js. A fresh filename per test is
// also what gets a fresh module: bun caches by path, and this page runs its setup at
// import time.

import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const HTML = readFileSync(join(REPO, "public", "lp-aboard.html"), "utf8");
const PAGE_JS = readFileSync(join(REPO, "public", "lp-aboard.js"), "utf8");
const OFFER_JS = join(REPO, "lib", "offer.js");

const SCRATCH = mkdtempSync(join(tmpdir(), "lp-aboard-page-"));
let copies = 0;

function freshPageModule(): string {
  copies++;
  const path = join(SCRATCH, `page-${copies}.js`);
  const source = PAGE_JS.replace('"./offer.js"', JSON.stringify(OFFER_JS));
  if (source === PAGE_JS) throw new Error("page.js no longer imports ./offer.js, this rewrite is stale");
  writeFileSync(path, source);
  return path;
}

// Variant ids and codes, same values the claim endpoint deals in.
const BASE_EN = "51542813409627";
const BASE_DE = "51542813540699";
const BIGBOX_EN = "51542655959387";
const KRAKEN = "51542942318939";
const COINS = "51676501508443";
const CODE_BASE = "KRAKEN-A7F2";
const CODE_BIGBOX = "FULLHOLD-B642";

/** What the page can see of the viewport, driven by the test rather than by scrolling. */
class FakeObserver {
  static live: FakeObserver[] = [];
  targets: any[] = [];
  disconnected = false;
  constructor(public callback: (entries: any[]) => void) {
    FakeObserver.live.push(this);
  }
  observe(el: any) {
    this.targets.push(el);
  }
  unobserve(el: any) {
    this.targets = this.targets.filter((t) => t !== el);
  }
  disconnect() {
    this.disconnected = true;
    this.targets = [];
  }
  /** Tell the page which of the things it is watching are on screen right now. */
  show(...onScreen: any[]) {
    this.callback(this.targets.map((target) => ({ target, isIntersecting: onScreen.includes(target) })));
  }
}

type Page = {
  document: any;
  window: any;
  scrolls: any[];
  requests: { url: string; body: any }[];
  observer: FakeObserver;
  claimAnswer: { status: number; body: any };
  submit: () => Promise<void>;
  click: (el: any, detail?: number) => Promise<void>;
  text: () => string;
};

/** Load the real page with a claim endpoint that answers whatever the test says. */
async function loadPage(answer: { status?: number; body: any }): Promise<Page> {
  const window = new Window({
    url: "https://nordicpirates.com/gift-offer",
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
    },
  });
  const document = window.document;
  document.write(HTML);

  const scrolls: any[] = [];
  const requests: { url: string; body: any }[] = [];
  const claimAnswer = { status: answer.status ?? 200, body: answer.body };

  // Where the page scrolled, which is the only observable half of a smooth scroll.
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: any) {
    scrolls.push(this);
  };
  window.HTMLElement.prototype.scrollTo = function scrollTo() {};

  FakeObserver.live = [];

  const globals = globalThis as any;
  globals.window = window;
  globals.document = document;
  globals.navigator = window.navigator;
  globals.IntersectionObserver = FakeObserver;
  globals.fetch = async (url: string, init: any) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(claimAnswer.body), {
      status: claimAnswer.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  // The browser's own email validation is not what these tests are about, and
  // happy-dom does not run it. The page's own "is this address usable" question is
  // the endpoint's, and it has its own tests.
  const email = document.getElementById("email");
  email.checkValidity = () => true;
  email.value = "crew@example.com";

  await import(freshPageModule());
  const settle = () => new Promise((done) => setTimeout(done, 0));

  return {
    document,
    window,
    scrolls,
    requests,
    get observer() {
      const watching = FakeObserver.live.filter((o) => o.targets.length);
      if (watching.length !== 1) throw new Error(`expected one live observer, found ${watching.length}`);
      return watching[0];
    },
    claimAnswer,
    async submit() {
      document
        .getElementById("giftform")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      await settle();
    },
    async click(el: any, detail = 1) {
      el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail }));
      await settle();
    },
    text: () => document.getElementById("result").textContent.replace(/\s+/g, " ").trim(),
  };
}

const codeAnswer = { state: "code", code: CODE_BASE, cartUrl: "https://nordicpirates.com/cart/x" };
const blockedAnswer = {
  state: "blocked",
  code: CODE_BIGBOX,
  baseCode: CODE_BASE,
  cartUrl: `https://nordicpirates.com/cart/${BIGBOX_EN}:1,${KRAKEN}:1,${COINS}:1?discount=${CODE_BIGBOX}`,
};

function cartLink(page: Page): any {
  return page.document.querySelector("#result [data-cart]");
}

function shownCode(page: Page): string {
  const el = page.document.querySelector("#result [data-code]");
  return el ? el.textContent.trim() : "";
}

/** The choices on screen right now, by their leading label. */
function choices(page: Page): string[] {
  return Array.from(page.document.querySelectorAll("#result [data-choice]")).map((b: any) =>
    b.textContent.replace(/\s+/g, " ").trim()
  );
}

test("choosing a box takes the visitor to the email field and puts the cursor in it", async () => {
  const page = await loadPage({ body: codeAnswer });

  for (const id of ["o-kraken", "o-coins", "o-bigbox"]) {
    page.document.activeElement?.blur?.();
    page.scrolls.length = 0;

    const pick = page.document.getElementById(id).closest(".pick");
    await page.click(pick);

    expect(page.scrolls).toContain(page.document.querySelector(".claim"));
    expect(page.document.activeElement.id).toBe("email");
  }
});

test("arrow keys through the boxes do not drag a keyboard visitor out of the group", async () => {
  // A radio group fires a click of its own with detail 0 when the arrow keys move
  // through it. Treating that as a choice would fling focus to the email field every
  // time somebody tried to read the second option.
  const page = await loadPage({ body: codeAnswer });

  const pick = page.document.getElementById("o-coins").closest(".pick");
  await page.click(pick, 0);

  expect(page.scrolls).toEqual([]);
  expect(page.document.activeElement.id).not.toBe("email");
});

test("the sticky gift button shows only when nothing else on screen leads to the picker", async () => {
  const page = await loadPage({ body: codeAnswer });
  const button = page.document.getElementById("gift-jump");
  const hero = page.document.querySelector(".hero-cta");
  const offer = page.document.getElementById("offer");
  const claim = page.document.querySelector(".claim");

  // Before anything is known about the viewport it stays out of the way.
  expect(button.hidden).toBe(true);

  page.observer.show(hero);
  expect(button.hidden).toBe(true);

  // Scrolled past the hero, with neither the picker nor the form in view.
  page.observer.show();
  expect(button.hidden).toBe(false);

  // The picker is the thing it points at, so it has nothing to say while that is up.
  page.observer.show(offer);
  expect(button.hidden).toBe(true);

  // And it must never sit on top of the claim form, which on a phone is where it
  // would land.
  page.observer.show(claim);
  expect(button.hidden).toBe(true);
});

test("the sticky gift button scrolls to the picker", async () => {
  const page = await loadPage({ body: codeAnswer });
  page.observer.show();

  await page.click(page.document.getElementById("gift-jump"));
  expect(page.scrolls).toContain(page.document.getElementById("offer"));
});

test("the sticky gift button goes for good once a code has been issued", async () => {
  const page = await loadPage({ body: codeAnswer });
  const button = page.document.getElementById("gift-jump");
  const observer = page.observer;

  observer.show();
  expect(button.hidden).toBe(false);

  await page.submit();
  expect(button.hidden).toBe(true);

  // Not just hidden this once: nothing is left watching that could bring it back.
  expect(observer.disconnected).toBe(true);
  observer.callback([{ target: page.document.getElementById("offer"), isIntersecting: false }]);
  expect(button.hidden).toBe(true);
});

test("a blocked visitor is asked which cart they want before any code appears", async () => {
  const page = await loadPage({ body: blockedAnswer });
  await page.submit();

  // The warning first. No code, in either direction, until they have chosen.
  const text = page.text();
  expect(text).toContain("That edition will not reach you");
  expect(text).toContain("The English Base Game is not in our European stock");
  expect(text).toContain("Your gift stands either way. Pick whichever suits you.");
  expect(shownCode(page)).toBe("");
  expect(text).not.toContain(CODE_BASE);
  expect(text).not.toContain(CODE_BIGBOX);
  expect(cartLink(page)).toBeNull();

  // Exactly two ways on, and neither is dressed up as the right one: same element,
  // same class, so the styling cannot tell them apart.
  const buttons = page.document.querySelectorAll("#result [data-choice]");
  expect(buttons.length).toBe(2);
  expect(choices(page)).toEqual([
    "Give me the European edition Same game, in your language.",
    "Give me the BIG BOX in English The full hold, in English, and both gifts come with it.",
  ]);
  expect(buttons[0].className).toBe(buttons[1].className);
  expect(buttons[0].tagName).toBe(buttons[1].tagName);

  // Polly's rules: no soft-soap, and no delivery promise anywhere on this screen.
  expect(text.toLowerCase()).not.toContain("unfortunately");
  expect(text).not.toMatch(/\b(week|weeks|day|days|business day)\b/i);
});

test("the European edition choice keeps the code they were issued and carts that edition", async () => {
  const page = await loadPage({ body: blockedAnswer });
  await page.submit();

  await page.click(page.document.querySelector('#result [data-choice="edition"]'));

  // Every edition the form offers except the one we just refused, named exactly as
  // the form names it.
  const editions = Array.from(page.document.querySelectorAll("#result [data-edition]"));
  expect(editions.map((b: any) => b.dataset.edition)).toEqual(["de", "fr", "es", "it"]);
  expect(editions.map((b: any) => b.textContent.trim())).toEqual([
    "Deutsch",
    "Français",
    "Español",
    "Italiano",
  ]);
  expect(page.document.querySelector('#result [data-edition="en"]')).toBeNull();

  await page.click(editions.find((b: any) => b.dataset.edition === "de"));

  // The Base Game code they were issued, unchanged, on a German Base Game cart.
  expect(shownCode(page)).toBe(CODE_BASE);
  const href = cartLink(page).href;
  expect(href).toContain(BASE_DE);
  expect(href).toContain(KRAKEN);
  expect(href).toContain(`discount=${CODE_BASE}`);
  expect(href).not.toContain(BASE_EN);
  expect(href).not.toContain(CODE_BIGBOX);

  // And the picker at the top of the page now agrees with what they chose, so
  // scrolling back up does not show them the edition we already said no to.
  expect(page.document.getElementById("ed-de").checked).toBe(true);
  expect(page.document.getElementById("ed-en").checked).toBe(false);

  // The nav language chip follows the same change, but that cannot be checked here:
  // the page finds the current edition with an "input:checked" selector, and this DOM
  // matches that selector against the checked ATTRIBUTE rather than against the live
  // state of the radio. A real browser matches the live state, which is why the same
  // read works on the page today for the nav chips. Checked by hand instead.
});

test("the BIG BOX choice shows the BIG BOX code and the BIG BOX cart", async () => {
  const page = await loadPage({ body: blockedAnswer });
  await page.submit();

  await page.click(page.document.querySelector('#result [data-choice="package"]'));

  expect(shownCode(page)).toBe(CODE_BIGBOX);
  const href = cartLink(page).href;
  expect(href).toContain(BIGBOX_EN);
  expect(href).toContain(KRAKEN);
  expect(href).toContain(COINS);
  expect(href).toContain(`discount=${CODE_BIGBOX}`);
  expect(href).not.toContain(CODE_BASE);

  // Three items in that cart, so the button may not say "the game and the gift".
  expect(cartLink(page).textContent).toBe("Put the BIG BOX and both gifts in my cart");

  // The Base Game code is the one we email this visitor, not this one, so this screen
  // does not claim their inbox is getting it.
  expect(page.text()).not.toContain("inbox");
});

test("the BIG BOX is still reachable from the edition list", async () => {
  // Somebody who opens the language list and finds nothing they read must not be
  // stuck there with a dead end.
  const page = await loadPage({ body: blockedAnswer });
  await page.submit();

  await page.click(page.document.querySelector('#result [data-choice="edition"]'));
  await page.click(page.document.querySelector('#result [data-choice="package"]'));

  expect(shownCode(page)).toBe(CODE_BIGBOX);
  expect(cartLink(page).href).toContain(BIGBOX_EN);
});

test("a blocked answer with no base code offers the one choice it can honour", async () => {
  // The language choice needs the code the visitor was issued. Without it the cart it
  // builds would carry no discount at all, which is a gift silently not given. One
  // honest choice beats two where the second is broken.
  const page = await loadPage({ body: { ...blockedAnswer, baseCode: undefined } });
  await page.submit();

  expect(page.document.querySelector('#result [data-choice="edition"]')).toBeNull();
  expect(page.document.querySelectorAll("#result [data-choice]").length).toBe(1);

  await page.click(page.document.querySelector('#result [data-choice="package"]'));
  expect(shownCode(page)).toBe(CODE_BIGBOX);
  expect(cartLink(page).href).toContain(`discount=${CODE_BIGBOX}`);
});

test("an unblocked visitor still gets their code and their cart in one go", async () => {
  const page = await loadPage({ body: codeAnswer });
  await page.submit();

  expect(page.requests.length).toBe(1);
  expect(page.requests[0].url).toBe("/gift-offer/claim");
  expect(page.requests[0].body).toEqual({
    email: "crew@example.com",
    offer: "base-kraken",
    edition: "en",
    company: "",
  });

  expect(page.text()).toContain("Welcome aboard");
  expect(shownCode(page)).toBe(CODE_BASE);
  expect(cartLink(page).href).toContain(BASE_EN);
  expect(cartLink(page).href).toContain(`discount=${CODE_BASE}`);
  expect(page.document.querySelectorAll("#result [data-choice]").length).toBe(0);
});

test("a refused claim says so and hands over nothing", async () => {
  const page = await loadPage({ status: 429, body: { error: "Too many attempts, try again later" } });
  await page.submit();

  expect(page.text()).toContain("That did not go through");
  expect(shownCode(page)).toBe("");
  expect(cartLink(page)).toBeNull();

  // The visitor may still want the picker, so the router stays.
  page.observer.show();
  expect(page.document.getElementById("gift-jump").hidden).toBe(false);
});

test("a state this page does not know is an error, not a blank panel", async () => {
  const page = await loadPage({ body: { state: "something-new", code: CODE_BASE } });
  await page.submit();

  expect(page.text()).toContain("That did not go through");
  expect(page.text()).not.toContain(CODE_BASE);
});
