// Tests for what the gift page DOES in a browser: the picker sends you to the email
// field, the sticky button follows you down the page and changes job when you choose,
// the reviewer section is gone, and a blocked visitor is asked which cart they want
// before any code appears.
//
// Straight off the acceptance criteria in issues #6 and #10. What happens to the CART
// after a code is issued is the other half of #10 and lives in lp-aboard-cart.test.ts.
// The harness both files drive the page with is tests/page-harness.ts.

import { test, expect } from "bun:test";
import {
  loadPage,
  selectOffer,
  tapPick,
  blockedAnswer,
  codeAnswer,
  BASE_DE,
  BASE_EN,
  BIGBOX_EN,
  KRAKEN,
  COINS,
  CODE_BASE,
  CODE_BIGBOX,
  type Page,
} from "./page-harness.ts";

/** Nothing to redirect into: these tests are about the page, not about the cart. */
const DEMO = "https://nordicpirates.com/gift-offer?no_redirect=1";

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

test("the top nav keeps its one selling button, on every screen", async () => {
  // Lucas could see neither CTA on his phone. This one has to be in the bar at every
  // width; that no stylesheet rule takes it away again is asserted in lp-aboard.test.ts.
  const page = await loadPage({ body: codeAnswer });
  const cta = page.document.querySelector(".np-nav-cta");

  expect(cta).not.toBeNull();
  expect(cta.textContent.trim()).toBe("Get the Game");
  expect(cta.getAttribute("href")).toBe("#offer");
  expect(cta.hidden).toBe(false);

  // And it is inside the sticky bar rather than somewhere further down the page.
  expect(page.document.getElementById("npnav").contains(cta)).toBe(true);
});

test("the reviewer section is gone, and so is the nav link that pointed at it", async () => {
  const page = await loadPage({ body: codeAnswer });

  expect(page.document.querySelector(".pros")).toBeNull();
  expect(page.document.getElementById("pros")).toBeNull();
  expect(page.document.querySelector('.np-links a[href="#pros"]')).toBeNull();

  const body = page.document.body.textContent;
  for (const gone of ["Unfiltered Gamer", "Meeple University", "Dice Tower", "What They Say"]) {
    expect(body).not.toContain(gone);
  }

  // The community reviews are a different section and Lucas did not ask for those.
  expect(page.document.getElementById("bgg-reviews")).not.toBeNull();
});

test("choosing a box scrolls the email field itself into the middle and focuses it", async () => {
  // Not the claim section: on a phone that puts the heading and two paragraphs on
  // screen and the field the visitor has to fill in below the fold.
  const page = await loadPage({ body: codeAnswer });
  const email = page.document.getElementById("email");
  const claim = page.document.querySelector(".claim");

  for (const id of ["o-kraken", "o-coins", "o-bigbox"]) {
    page.document.activeElement?.blur?.();
    page.scrolls.length = 0;

    await tapPick(page, id);

    expect(page.scrolledTo(email)).toEqual({ behavior: "smooth", block: "center" });
    expect(page.scrolledTo(claim)).toBeUndefined();
    expect(page.document.activeElement.id).toBe("email");
  }
});

test("the heading over the email field names the gift that is chosen", async () => {
  const page = await loadPage({ body: codeAnswer });
  const title = () => page.document.getElementById("claim-title").textContent.trim();

  // The box that starts out chosen, named in the markup and not only once JS runs.
  expect(title()).toBe("One step and the Kraken is yours");

  await tapPick(page, "o-coins");
  expect(title()).toBe("One step and the gold coins are yours");

  await tapPick(page, "o-bigbox");
  expect(title()).toBe("One step and both gifts are yours");

  await tapPick(page, "o-kraken");
  expect(title()).toBe("One step and the Kraken is yours");
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

test("the floating CTA shows whenever the picker is off screen, hero and claim included", async () => {
  // The old rule hid it while the hero CTA, the picker OR the claim section was in
  // view, which between them is nearly the whole page, so nobody ever saw it.
  const page = await loadPage({ body: codeAnswer });
  const button = page.document.getElementById("gift-jump");
  const offer = page.document.getElementById("offer");
  const email = page.document.getElementById("email");

  // Before anything is known about the viewport it stays out of the way.
  expect(button.hidden).toBe(true);

  // Top of the page, hero CTA on screen, picker not yet. It has somewhere to send you.
  page.observer.show();
  expect(button.hidden).toBe(false);
  expect(button.textContent).toBe("Pick your gift!");

  // The picker is the thing it points at, so it has nothing to say while that is up.
  page.observer.show(offer);
  expect(button.hidden).toBe(true);

  // Scrolled past it again, still visible. This is the state Lucas never got to see.
  page.observer.show();
  expect(button.hidden).toBe(false);

  // Only the email field itself takes it away at the bottom, so it can never sit on
  // top of the one input on the page.
  page.observer.show(email);
  expect(button.hidden).toBe(true);

  // Both at once, which is the tall-desktop case.
  page.observer.show(offer, email);
  expect(button.hidden).toBe(true);
});

test("the floating CTA changes job once a box has been chosen", async () => {
  const page = await loadPage({ body: codeAnswer });
  const button = page.document.getElementById("gift-jump");
  const offer = page.document.getElementById("offer");
  const email = page.document.getElementById("email");

  page.observer.show();
  expect(button.textContent).toBe("Pick your gift!");

  await page.click(button);
  expect(page.scrolledTo(offer)).toEqual({ behavior: "smooth", block: "start" });

  // Choosing a box is what changes its job. The picker is on screen for that, so the
  // button is not, and the visitor scrolls on down.
  page.observer.show(offer);
  await tapPick(page, "o-coins");
  page.observer.show();

  expect(button.hidden).toBe(false);
  expect(button.textContent).toBe("Continue to email");

  page.scrolls.length = 0;
  page.document.activeElement?.blur?.();
  await page.click(button);

  expect(page.scrolledTo(email)).toEqual({ behavior: "smooth", block: "center" });
  expect(page.document.activeElement.id).toBe("email");
});

test("an arrow-key choice changes the floating CTA too, without moving focus", async () => {
  const page = await loadPage({ body: codeAnswer });
  const button = page.document.getElementById("gift-jump");

  page.observer.show();

  // What a real radio group does when the arrow keys move through it: the selection
  // changes, and no click ever lands on the card.
  selectOffer(page, "o-coins");

  expect(button.textContent).toBe("Continue to email");
  expect(page.document.getElementById("claim-title").textContent.trim()).toBe(
    "One step and the gold coins are yours"
  );
  expect(page.document.activeElement.id).not.toBe("email");
});

test("the floating CTA goes for good once a code has been issued", async () => {
  const page = await loadPage({ body: codeAnswer }, DEMO);
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
  const page = await loadPage({ body: blockedAnswer }, DEMO);
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
  const page = await loadPage({ body: blockedAnswer }, DEMO);
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

test("answering inside the panel keeps focus inside the panel", async () => {
  // Every choice replaces the button that was just pressed. Without somewhere to put
  // focus it lands back at the top of the document, and a keyboard visitor has to walk
  // the whole page again to find out what their answer did.
  const page = await loadPage({ body: blockedAnswer }, DEMO);
  await page.submit();

  // The submit did not move focus: the visitor put it where it is.
  expect(page.document.activeElement.id).not.toBe("");

  const language = page.document.querySelector('#result [data-choice="edition"]');
  language.focus();
  await page.click(language);

  let focused = page.document.activeElement;
  expect(page.document.getElementById("result").contains(focused)).toBe(true);
  expect(focused.tagName).toBe("H3");
  expect(focused.textContent).toContain("Which edition should we ship");

  const german = page.document.querySelector('#result [data-edition="de"]');
  german.focus();
  await page.click(german);

  focused = page.document.activeElement;
  expect(page.document.getElementById("result").contains(focused)).toBe(true);
  expect(focused.tagName).toBe("H3");
});

test("the BIG BOX is still reachable from the edition list", async () => {
  // Somebody who opens the language list and finds nothing they read must not be
  // stuck there with a dead end.
  const page = await loadPage({ body: blockedAnswer }, DEMO);
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
  const page = await loadPage({ body: { ...blockedAnswer, baseCode: undefined } }, DEMO);
  await page.submit();

  expect(page.document.querySelector('#result [data-choice="edition"]')).toBeNull();
  expect(page.document.querySelectorAll("#result [data-choice]").length).toBe(1);

  await page.click(page.document.querySelector('#result [data-choice="package"]'));
  expect(shownCode(page)).toBe(CODE_BIGBOX);
  expect(cartLink(page).href).toContain(`discount=${CODE_BIGBOX}`);
});

test("the form posts what the visitor picked, and nothing it was not given", async () => {
  const page = await loadPage({ body: codeAnswer }, DEMO);
  await page.submit();

  expect(page.calls.length).toBe(1);
  expect(page.calls[0].url).toBe("/gift-offer/claim");
  expect(page.calls[0].method).toBe("POST");
  expect(page.calls[0].body).toEqual({
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
  expect(page.cartCalls()).toEqual([]);
});
