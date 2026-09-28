// What happens to the visitor's Shopify cart once a code is issued, via tests/page-harness.ts.
// Why the page builds the cart itself, and what each part pins: docs/TESTS-GIFT-CART.md

import { afterAll, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  loadPage,
  selectOffer,
  blockedAnswer,
  codeAnswer,
  discountPath,
  BASE_DE,
  BIGBOX_EN,
  BASE_EN,
  KRAKEN,
  COINS,
  CART,
  CART_ADD,
  CART_CLEAR,
  CODE_BASE,
  CODE_BIGBOX,
  CODE_VISIBLE_MS,
  REDIRECT_TEST_MS,
  say,
  tapOffer,
  restorePageGlobals,
  type Page,
} from "./page-harness.ts";

// Put back the browser globals loadPage replaced, so later files see Bun's own.
afterAll(restorePageGlobals);

const DEMO = "https://nordicpirates.com/gift-offer?no_redirect=1";

/** Just the paths, in the order the page asked for them. */
function cartPaths(page: Page): string[] {
  return page.cartCalls().map((c) => c.url);
}

function addedIds(page: Page): string[] {
  const add = page.cartCalls().find((c) => c.url === CART_ADD);
  return add ? add.body.items.map((i: any) => i.id) : [];
}

test("a successful claim empties the cart, loads it, applies the code, then goes to the cart", async () => {
  const page = await loadPage({ body: codeAnswer });
  await page.submit();

  const landed = await page.navigated();

  // The one order that works; clearing first makes this campaign's cart the cart.
  // docs/TESTS-GIFT-CART.md
  expect(cartPaths(page)).toEqual([CART_CLEAR, CART_ADD, discountPath(CODE_BASE)]);

  const [clear, add] = page.cartCalls();
  expect(clear.method).toBe("POST");
  expect(add.method).toBe("POST");
  expect(add.body).toEqual({
    items: [
      { id: BASE_EN, quantity: 1 },
      { id: KRAKEN, quantity: 1 },
    ],
  });

  // The cart page, not the checkout. This is the whole point of the change: the shop's
  // other offers live on the cart page and Shop Pay skips them.
  expect(landed).toBe(CART);
  expect(page.navigations.length).toBe(1);
}, REDIRECT_TEST_MS);

test("every call goes to a bare path, so it reaches the shop and not the portal", async () => {
  // Bare paths only: absolute is cross-origin, /gift-offer lands on the portal.
  // docs/TESTS-GIFT-CART.md
  const page = await loadPage({ body: codeAnswer });
  await page.submit();
  await page.navigated();

  for (const call of page.cartCalls()) {
    expect(call.url.startsWith("/")).toBe(true);
    expect(call.url).not.toContain("://");
    expect(call.url).not.toContain("/gift-offer");
  }
}, REDIRECT_TEST_MS);

test("the code is on screen, and stays there, before the page moves under them", async () => {
  // A code that flashed past before the redirect is a code they never got.
  // docs/TESTS-GIFT-CART.md
  const page = await loadPage({ body: codeAnswer });
  const started = Date.now();
  await page.submit();

  const text = page.text();
  expect(text).toContain("Code unlocked");
  expect(text.toLowerCase()).toContain("taking you to your cart");
  expect(page.document.querySelector("#result [data-code]").textContent.trim()).toBe(CODE_BASE);
  expect(page.navigations).toEqual([]);

  // Still there a second later, with the cart already built underneath it. This is the
  // half that matters: the hold is a real one, not the incidental gap a fetch leaves.
  await page.until(() => page.cartCalls().length === 3, "the cart to finish loading");
  expect(page.navigations).toEqual([]);
  expect(page.document.querySelector("#result [data-code]").textContent.trim()).toBe(CODE_BASE);

  await page.navigated();
  expect(Date.now() - started).toBeGreaterThanOrEqual(CODE_VISIBLE_MS);
}, REDIRECT_TEST_MS);

test("the BIG BOX loads three items and its own code", async () => {
  const page = await loadPage({ body: { state: "code", code: CODE_BIGBOX } });
  selectOffer(page, "o-bigbox");

  await page.submit();
  await page.navigated();

  expect(addedIds(page)).toEqual([BIGBOX_EN, KRAKEN, COINS]);
  expect(cartPaths(page)[2]).toBe(discountPath(CODE_BIGBOX));
  expect(cartPaths(page)[2]).not.toContain(CODE_BASE);
}, REDIRECT_TEST_MS);

// A box tapped while the claim is in flight must not split what is shown from what is
// carted. docs/TESTS-GIFT-CART.md
const CART_FOR: Record<string, string[]> = {
  "base-kraken": [BASE_EN, KRAKEN],
  "base-coins": [BASE_EN, COINS],
  "bigbox-both": [BIGBOX_EN, KRAKEN, COINS],
};

test(
  "a box tapped while the claim is in flight cannot move the gift that goes in the cart",
  async () => {
    const page = await loadPage({ body: codeAnswer });
    const release = page.holdClaim();

    // The Kraken box is the one checked in the markup, so that is what goes out.
    await page.submit();
    expect(page.calls[0].body.offer).toBe("base-kraken");
    expect(page.cartCalls()).toEqual([]);

    // They change their mind to the BIG BOX while the answer is still in the air.
    tapOffer(page, "o-bigbox");

    release();
    await page.navigated();

    // The box on screen is the box in the cart, read off the page. docs/TESTS-GIFT-CART.md
    const shown = page.document.querySelector('input[name="offer"]:checked').value;
    expect(addedIds(page)).toEqual(CART_FOR[shown]);

    // And the box that is kept is the one the claim was made for, with the heading over
    // the email field naming that same box rather than the one that was tapped.
    expect(shown).toBe("base-kraken");
    expect(page.document.getElementById("claim-title").textContent.trim()).toBe(
      say("en", "claim.title.kraken")
    );
  },
  REDIRECT_TEST_MS
);

test("the gift radios are held with the language, and handed back with it", async () => {
  // How the test above is kept true. no_redirect so the page stays put and the release
  // can be watched: what happens to the cart afterwards is the test above's business.
  const page = await loadPage({ body: codeAnswer }, DEMO);
  const release = page.holdClaim();

  await page.submit();

  // Visibly held rather than dead, the same as the edition radios and the submit button
  // beside them: a control the visitor can see is not theirs for the moment.
  const bigbox = page.document.getElementById("o-bigbox");
  expect(bigbox.disabled).toBe(true);

  // Both events dispatched anyway, because a held control that still acted on them would
  // be the same bug wearing a disabled attribute.
  bigbox.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await page.click(bigbox.closest(".pick"));

  // The heading still names the box that was posted, and the tap did not answer the
  // visitor by carrying them to the email field as though it had landed.
  expect(page.document.getElementById("claim-title").textContent.trim()).toBe(
    say("en", "claim.title.kraken")
  );
  expect(page.scrolledTo(page.document.getElementById("email"))).toBeUndefined();

  release();
  await page.until(() => !!page.document.querySelector("#result [data-code]"), "the code");

  // The answer has landed and the visitor has something to act on, so the gift is theirs
  // to change again rather than staying dead for the rest of the page's life.
  expect(bigbox.disabled).toBe(false);
});

test(
  "the wait between a built cart and the redirect cannot move either control",
  async () => {
    // The cart is settled while the code is held on screen, so no control may move.
    // docs/TESTS-GIFT-CART.md
    const page = await loadPage({ body: codeAnswer });
    await page.submit();
    await page.until(() => page.cartCalls().length === 3, "the cart to finish loading");
    expect(page.navigations).toEqual([]);

    const bigbox = page.document.getElementById("o-bigbox");
    const french = page.document.getElementById("ed-fr");
    expect(bigbox.disabled).toBe(true);
    expect(french.disabled).toBe(true);

    tapOffer(page, "o-bigbox");
    french.dispatchEvent(new page.window.Event("change", { bubbles: true }));

    await page.navigated();

    const shown = page.document.querySelector('input[name="offer"]:checked').value;
    expect(addedIds(page)).toEqual(CART_FOR[shown]);
    expect(shown).toBe("base-kraken");
    expect(page.document.querySelector('input[name="edition"]:checked').value).toBe("en");
  },
  REDIRECT_TEST_MS
);

test("a blocked visitor's cart is not touched until they have chosen", async () => {
  const page = await loadPage({ body: blockedAnswer });
  await page.submit();

  // They are being asked a question. Loading a cart for a package we have just said we
  // cannot ship would be the same mistake in a new place.
  expect(page.cartCalls()).toEqual([]);
  expect(page.navigations).toEqual([]);
  expect(page.text()).toContain("That edition will not reach you");
});

test("the BIG BOX choice loads the BIG BOX cart with the BIG BOX code", async () => {
  const page = await loadPage({ body: blockedAnswer });
  await page.submit();

  await page.click(page.document.querySelector('#result [data-choice="package"]'));
  const landed = await page.navigated();

  expect(cartPaths(page)).toEqual([CART_CLEAR, CART_ADD, discountPath(CODE_BIGBOX)]);
  expect(addedIds(page)).toEqual([BIGBOX_EN, KRAKEN, COINS]);
  expect(landed).toBe(CART);
}, REDIRECT_TEST_MS);

test("the European edition choice loads that edition with the code they were issued", async () => {
  const page = await loadPage({ body: blockedAnswer });
  await page.submit();

  await page.click(page.document.querySelector('#result [data-choice="edition"]'));
  await page.click(page.document.querySelector('#result [data-edition="de"]'));
  const landed = await page.navigated();

  // The German base game and its gift, on the code the visitor was issued and emailed.
  expect(addedIds(page)).toEqual([BASE_DE, KRAKEN]);
  expect(cartPaths(page)[2]).toBe(discountPath(CODE_BASE));
  expect(cartPaths(page)[2]).not.toContain(CODE_BIGBOX);
  expect(landed).toBe(CART);
}, REDIRECT_TEST_MS);

test("a cart that will not build keeps the code on screen, with a way to try again", async () => {
  // The one unrecoverable outcome here would be losing the code because the shop had a
  // bad moment. Everything else can be retried.
  for (const broken of [CART_CLEAR, CART_ADD]) {
    const page = await loadPage({ body: codeAnswer });
    page.cartStatus = (path) => (path === broken ? 422 : 200);

    await page.submit();
    await page.until(() => !!page.document.querySelector("#result [data-code]"), "the code to come back");

    expect(page.navigations).toEqual([]);
    expect(page.document.querySelector("#result [data-code]").textContent.trim()).toBe(CODE_BASE);
    expect(page.text()).toContain("Your code is safe");

    // Both ways out are on screen: the cart link the claim endpoint built, and a retry.
    const link = page.document.querySelector("#result [data-cart]");
    expect(link.href).toContain(BASE_EN);
    expect(link.href).toContain(`discount=${CODE_BASE}`);

    const retry = page.document.querySelector("#result [data-retry]");
    expect(retry).not.toBeNull();
    expect(retry.hidden).toBe(false);
  }
});

test("the retry runs the whole sequence again and takes them to the cart", async () => {
  const page = await loadPage({ body: codeAnswer });
  page.cartStatus = (path) => (path === CART_ADD ? 500 : 200);

  await page.submit();
  await page.until(() => !!page.document.querySelector("#result [data-retry]"), "the retry button");

  const failed = page.cartCalls().length;
  page.cartStatus = () => 200;
  await page.click(page.document.querySelector("#result [data-retry]"));

  const landed = await page.navigated();
  // The whole sequence over again, not just the call that failed.
  expect(cartPaths(page).slice(failed)).toEqual([CART_CLEAR, CART_ADD, discountPath(CODE_BASE)]);
  expect(landed).toBe(CART);
}, REDIRECT_TEST_MS);

test("a discount call that does not go through still lands them on a cart with the code", async () => {
  // The same link works as a destination: Shopify applies the code and sends the
  // browser on to the cart. So a failed request costs a redirect, not the gift.
  const page = await loadPage({ body: codeAnswer });
  page.cartStatus = (path) => (path.startsWith("/discount/") ? 404 : 200);

  await page.submit();
  const landed = await page.navigated();

  expect(addedIds(page)).toEqual([BASE_EN, KRAKEN]);
  expect(landed).toBe(discountPath(CODE_BASE));
  expect(landed).toContain("redirect=/cart");
}, REDIRECT_TEST_MS);

test("no_redirect=1 hands over the code and touches nobody's cart", async () => {
  // The escape hatch for checking this live without emptying the reviewer's own cart.
  const page = await loadPage({ body: codeAnswer }, DEMO);
  await page.submit();

  expect(page.cartCalls()).toEqual([]);
  expect(page.navigations).toEqual([]);
  expect(page.document.querySelector("#result [data-code]").textContent.trim()).toBe(CODE_BASE);
  expect(page.document.querySelector("#result [data-cart]").href).toContain(BASE_EN);
  expect(page.document.querySelector("#result [data-retry]")).toBeNull();
});

test("no_redirect=1 holds for the blocked choices too", async () => {
  const page = await loadPage({ body: blockedAnswer }, DEMO);
  await page.submit();

  await page.click(page.document.querySelector('#result [data-choice="package"]'));

  expect(page.cartCalls()).toEqual([]);
  expect(page.navigations).toEqual([]);
  expect(page.document.querySelector("#result [data-code]").textContent.trim()).toBe(CODE_BIGBOX);
});

test("there is one road to a cart, and one to a cart link", async () => {
  // One call site per cart builder, so a new road to a cart fails here while being written.
  // docs/TESTS-GIFT-CART.md
  const source = readFileSync(join(import.meta.dir, "..", "public", "lp-aboard.js"), "utf8");
  const callsTo = (name: string) => source.split(`${name}(`).length - 1;

  expect(callsTo("loadCart"), "the page builds a cart somewhere new").toBe(1);
  expect(callsTo("buildCartUrl"), "the page builds a cart link somewhere new").toBe(1);
});

test("a claim that never issues a code touches no cart at all", async () => {
  const page = await loadPage({ status: 500, body: { error: "no" } });
  await page.submit();

  expect(page.cartCalls()).toEqual([]);
  expect(page.navigations).toEqual([]);
});
