// The real gift page in a DOM, driven with real events; only missing browser pieces are
// faked, so a test can drive them. Why each fake is shaped so: docs/TESTS-PAGE-HARNESS.md

import { Window } from "happy-dom";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EN } from "../public/lp-aboard-i18n-en.js";
import { DE } from "../public/lp-aboard-i18n-de.js";
import { IT } from "../public/lp-aboard-i18n-it.js";
import { FR } from "../public/lp-aboard-i18n-fr.js";
import { ES } from "../public/lp-aboard-i18n-es.js";

const REPO = join(import.meta.dir, "..");
export const HTML = readFileSync(join(REPO, "public", "lp-aboard.html"), "utf8");
const PAGE_JS = readFileSync(join(REPO, "public", "lp-aboard.js"), "utf8");
const CART_JS = readFileSync(join(REPO, "public", "lp-aboard-cart.js"), "utf8");
const I18N_JS = readFileSync(join(REPO, "public", "lp-aboard-i18n.js"), "utf8");
const OFFER_JS = join(REPO, "lib", "offer.js");

/** The five the page ships, in the order the nav chips sit in. */
export const LANGUAGES = ["en", "de", "it", "fr", "es"];

// How long the page holds the code before it navigates, read out of the page itself.
// docs/TESTS-PAGE-HARNESS.md
export const CODE_VISIBLE_MS = (() => {
  const match = /const CODE_VISIBLE_MS = (\d+);/.exec(PAGE_JS);
  if (!match) throw new Error("page.js no longer declares CODE_VISIBLE_MS, this read is stale");
  return Number(match[1]);
})();

// Per-test timeout for a test that waits out a real redirect: the third argument to
// test(). Why it exists and is derived: docs/TESTS-PAGE-HARNESS.md
export const REDIRECT_TEST_MS = CODE_VISIBLE_MS * 4;

/** Every copy table, the same objects the page itself imports. */
export const COPY: Record<string, Record<string, string>> = { en: EN, de: DE, it: IT, fr: FR, es: ES };

/** What the page should say for one key, in one language. */
export function say(lang: string, key: string): string {
  const value = COPY[lang]?.[key];
  if (value === undefined) throw new Error(`no "${lang}" copy for "${key}"`);
  return value;
}

const SCRATCH = mkdtempSync(join(tmpdir(), "lp-aboard-page-"));
let copies = 0;

/** The Shopify paths the page talks to, as the browser sees them: same-origin. */
export const CART_CLEAR = "/cart/clear.js";
export const CART_ADD = "/cart/add.js";
export const CART = "/cart";
export const discountPath = (code: string) => `/discount/${encodeURIComponent(code)}?redirect=/cart`;

/** Variant ids and codes, the same values the claim endpoint deals in. */
export const BASE_EN = "51542813409627";
export const BASE_DE = "51542813540699";
export const BIGBOX_EN = "51542655959387";
export const KRAKEN = "51542942318939";
export const COINS = "51676501508443";
export const CODE_BASE = "KRAKEN-A7F2";
export const CODE_BIGBOX = "FULLHOLD-B642";

export const codeAnswer = { state: "code", code: CODE_BASE, cartUrl: "https://nordicpirates.com/cart/x" };
export const blockedAnswer = {
  state: "blocked",
  code: CODE_BIGBOX,
  baseCode: CODE_BASE,
  cartUrl: `https://nordicpirates.com/cart/${BIGBOX_EN}:1,${KRAKEN}:1,${COINS}:1?discount=${CODE_BIGBOX}`,
};

function rewrite(source: string, from: string, to: string, what: string): string {
  const out = source.replace(from, JSON.stringify(to));
  if (out === source) throw new Error(`${what} no longer imports ${from}, this rewrite is stale`);
  return out;
}

function freshPageModule(): string {
  copies++;

  const cartPath = join(SCRATCH, `cart-${copies}.js`);
  writeFileSync(cartPath, rewrite(CART_JS, '"./offer.js"', OFFER_JS, "cart.js"));

  // The copy tables are not rewritten, only pointed at: they hold no imports of their
  // own, so every page in a run reads the same five real files the browser is served.
  const i18nPath = join(SCRATCH, `i18n-${copies}.js`);
  let i18n = I18N_JS;
  for (const lang of LANGUAGES) {
    i18n = rewrite(
      i18n,
      `"./i18n-${lang}.js"`,
      join(REPO, "public", `lp-aboard-i18n-${lang}.js`),
      "i18n.js"
    );
  }
  writeFileSync(i18nPath, i18n);

  const pagePath = join(SCRATCH, `page-${copies}.js`);
  let page = rewrite(PAGE_JS, '"./offer.js"', OFFER_JS, "page.js");
  page = rewrite(page, '"./cart.js"', cartPath, "page.js");
  page = rewrite(page, '"./i18n.js"', i18nPath, "page.js");
  writeFileSync(pagePath, page);

  return pagePath;
}

// Choose a box the way a real radio group does, moving the checked attribute too.
// Why the attribute and the change event: docs/TESTS-PAGE-HARNESS.md
export function selectOffer(page: Page, id: string) {
  const input = page.document.getElementById(id);
  if (!input) throw new Error(`no offer input "${id}" on the page`);

  for (const radio of page.document.querySelectorAll('input[name="offer"]')) {
    const isIt = radio === input;
    if (isIt) radio.setAttribute("checked", "");
    else radio.removeAttribute("checked");
    radio.checked = isIt;
  }
  input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  return input;
}

// A visitor tapping a box as a browser delivers it: a disabled radio does not move.
// How this differs from selectOffer: docs/TESTS-PAGE-HARNESS.md
export function tapOffer(page: Page, id: string) {
  const input = page.document.getElementById(id);
  if (!input) throw new Error(`no offer input "${id}" on the page`);

  if (input.disabled) {
    input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    return input;
  }
  return selectOffer(page, id);
}

/** A visitor tapping a box: the radio changes, then the click lands on the card. */
export async function tapPick(page: Page, id: string) {
  const input = selectOffer(page, id);
  await page.click(input.closest(".pick"));
}

/** What the page can see of the viewport, driven by the test rather than by scrolling. */
export class FakeObserver {
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

export type Call = { url: string; method: string; body: any };

export type Page = {
  document: any;
  window: any;
  /** Every scrollIntoView the page asked for, in order, with the options it passed. */
  scrolls: { target: any; options: any }[];
  /** Every fetch the page made: the claim endpoint and Shopify's cart both. */
  calls: Call[];
  /** Just the Shopify cart side of it, which is what most cart tests care about. */
  cartCalls: () => Call[];
  /** Where the page sent the browser. Empty until it navigates. */
  navigations: string[];
  observer: FakeObserver;
  claimAnswer: { status: number; body: any };
  /** What Shopify answers for a given path. Tests overwrite this to break the cart. */
  cartStatus: (path: string) => number;
  /** Hold the claim answer in the air and hand back the release. docs/TESTS-PAGE-HARNESS.md */
  holdClaim: () => () => void;
  submit: () => Promise<void>;
  click: (el: any, detail?: number) => Promise<void>;
  text: () => string;
  scrolledTo: (el: any) => any | undefined;
  until: (check: () => boolean, what: string) => Promise<void>;
  navigated: () => Promise<string>;
};

// Load the real page with a claim endpoint and a cart that answer what the test says;
// `url` carries the query string. docs/TESTS-PAGE-HARNESS.md
export async function loadPage(answer: { status?: number; body: any }, url?: string): Promise<Page> {
  const window = new Window({
    url: url || "https://nordicpirates.com/gift-offer",
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
    },
  });
  const document = window.document;
  document.write(HTML);

  const scrolls: { target: any; options: any }[] = [];
  const calls: Call[] = [];
  const navigations: string[] = [];
  const claimAnswer = { status: answer.status ?? 200, body: answer.body };
  const cart = { status: (_path: string) => 200 };

  // Nothing by default: the claim answers as fast as the process can, which is what
  // every other test wants. holdClaim below puts a gate in front of it.
  let claimGate: Promise<void> | null = null;
  let openClaimGate: (() => void) | null = null;

  // Where the page scrolled, which is the only observable half of a smooth scroll.
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: any, options: any) {
    scrolls.push({ target: this, options });
  };
  window.HTMLElement.prototype.scrollTo = function scrollTo() {};

  // Where it sent the browser. Real navigation would tear the document down.
  window.location.assign = (to: string) => {
    navigations.push(to);
  };

  FakeObserver.live = [];

  const globals = globalThis as any;
  globals.window = window;
  globals.document = document;
  globals.navigator = window.navigator;
  globals.IntersectionObserver = FakeObserver;
  globals.fetch = async (path: string, init: any = {}) => {
    const method = (init.method || "GET").toUpperCase();
    let body: any = null;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: path, method, body });

    if (path === "/gift-offer/claim") {
      if (claimGate) await claimGate;
      return new Response(JSON.stringify(claimAnswer.body), {
        status: claimAnswer.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const status = cart.status(path);
    return new Response(status < 400 ? "{}" : '{"description":"Shopify said no"}', {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  // Browser email validation is not under test and happy-dom does not run it; the
  // endpoint owns that question. docs/TESTS-PAGE-HARNESS.md
  const email = document.getElementById("email");
  email.checkValidity = () => true;
  email.value = "crew@example.com";

  await import(freshPageModule());

  const settle = () => new Promise((done) => setTimeout(done, 0));
  // The page waits a frame and then a task before scrolling, so a phone has finished
  // moving. A test that asserts on the scroll has to let both of those happen.
  const frame = () =>
    new Promise((done) => window.requestAnimationFrame(() => setTimeout(done, 0)));

  const page: Page = {
    document,
    window,
    scrolls,
    calls,
    cartCalls: () => calls.filter((c) => c.url !== "/gift-offer/claim"),
    navigations,
    get observer() {
      const watching = FakeObserver.live.filter((o) => o.targets.length);
      if (watching.length !== 1) throw new Error(`expected one live observer, found ${watching.length}`);
      return watching[0];
    },
    claimAnswer,
    set cartStatus(fn: (path: string) => number) {
      cart.status = fn;
    },
    get cartStatus() {
      return cart.status;
    },
    holdClaim() {
      if (claimGate) throw new Error("the claim answer is already being held");
      claimGate = new Promise<void>((done) => {
        openClaimGate = done;
      });
      return () => {
        if (!openClaimGate) throw new Error("this claim answer has already been released");
        openClaimGate();
        openClaimGate = null;
        claimGate = null;
      };
    },
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
      await frame();
    },
    text: () => document.getElementById("result").textContent.replace(/\s+/g, " ").trim(),
    scrolledTo: (el: any) => scrolls.find((s) => s.target === el)?.options,
    async until(check: () => boolean, what: string) {
      // Comfortably past CODE_VISIBLE_MS, so the wait never races the hold under test.
      // docs/TESTS-PAGE-HARNESS.md
      for (let waited = 0; waited < 15000; waited += 10) {
        if (check()) return;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error(`gave up waiting for ${what}`);
    },
    async navigated() {
      await page.until(() => navigations.length > 0, "the page to navigate");
      return navigations[0];
    },
  };

  return page;
}
