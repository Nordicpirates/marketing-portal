// The real gift page, loaded into a DOM and driven with real events.
//
// Nothing here re-implements the page. The only things faked are the browser pieces a
// test process does not have, and each of them is faked so a test can DRIVE it (what
// the claim endpoint answers, what Shopify's cart answers, what is on screen, where
// the page scrolled, where it navigated), never so the page can avoid it.
//
// About the module copies: page.js imports "./offer.js" and "./cart.js", which the
// browser resolves against /gift-offer/page.js and the server answers from lib/ and
// public/. On disk those files are not siblings, so each test writes its own copy of
// page.js and cart.js with those imports pointed at the real files. A fresh filename
// per test is also what gets a fresh module: bun caches by path, and this page runs
// its setup at import time.

import { Window } from "happy-dom";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
export const HTML = readFileSync(join(REPO, "public", "lp-aboard.html"), "utf8");
const PAGE_JS = readFileSync(join(REPO, "public", "lp-aboard.js"), "utf8");
const CART_JS = readFileSync(join(REPO, "public", "lp-aboard-cart.js"), "utf8");
const OFFER_JS = join(REPO, "lib", "offer.js");

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

  const pagePath = join(SCRATCH, `page-${copies}.js`);
  let page = rewrite(PAGE_JS, '"./offer.js"', OFFER_JS, "page.js");
  page = rewrite(page, '"./cart.js"', cartPath, "page.js");
  writeFileSync(pagePath, page);

  return pagePath;
}

/**
 * Choose one of the boxes, the way a real radio group does it.
 *
 * The checked ATTRIBUTE is moved as well as the property because this DOM matches
 * "input:checked" against the attribute rather than against the live state of the
 * radio. A real browser matches the live state, which is why the page reads its
 * selection with that selector. Without this, every test would be submitting the box
 * that happens to be checked in the markup.
 *
 * The change event is dispatched here for the same reason a browser dispatches it
 * during the click: it fires before the click reaches anything around the radio.
 */
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
  submit: () => Promise<void>;
  click: (el: any, detail?: number) => Promise<void>;
  text: () => string;
  scrolledTo: (el: any) => any | undefined;
  until: (check: () => boolean, what: string) => Promise<void>;
  navigated: () => Promise<string>;
};

/**
 * Load the real page with a claim endpoint and a cart that answer whatever the test
 * says. `url` carries the query string, which is how ?no_redirect=1 gets tested.
 */
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

  // The browser's own email validation is not what these tests are about, and
  // happy-dom does not run it. The page's own "is this address usable" question is
  // the endpoint's, and it has its own tests.
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
      for (let waited = 0; waited < 3000; waited += 10) {
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
