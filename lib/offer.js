// Gift offer: which Shopify variants go in the cart, and how the cart link is built.
//
// This file is loaded TWICE on purpose: the claim endpoint imports it, and the
// browser loads it from /gift-offer/offer.js. One copy of the variant IDs, so the
// code the server puts in its response and the link the page builds can never drift.
// Plain JS (not TS) so the browser can run it without a build step.
//
// Variant IDs verified against live Shopify on 2026-08-05. Do NOT copy IDs out of
// the old v18 mockup: every demo link in it used the FRENCH base variant.

// The shop lives on a different host than this page, so cart links are absolute.
export const SHOP_ORIGIN = "https://nordicpirates.com";

export const EDITIONS = ["en", "de", "fr", "es", "it"];
export const OFFERS = ["base-kraken", "base-coins", "bigbox-both"];

// Base Game, 39.95
export const BASE_VARIANTS = {
  en: "51542813409627",
  fr: "51542813442395",
  es: "51542813475163",
  it: "51542813507931",
  de: "51542813540699",
};

// BIG BOX, 124.95
export const BIGBOX_VARIANTS = {
  en: "51542655959387",
  fr: "51542655992155",
  es: "51542656024923",
  it: "51542656057691",
  de: "51542656090459",
};

export const GIFT_KRAKEN = "51542942318939"; // Kraken Mini-Expansion, 7.95
export const GIFT_COINS = "51676501508443"; // Gold Coins 20 pcs, 11.95

// The BIG BOX cart is three items, which used to trip the shop's automatic "Bundles"
// rule and take 10% off everything instead of giving the gifts away. Both codes are
// live in Shopify now and were checked against the storefront price engine on
// 2026-08-05: BXGY fires, the code beats the automatic Bundles discount, and the
// cheat-cap holds. So the BIG BOX cart link carries its code.
//
// The BIG BOX code is its own BXGY rule and only grants anything when a BIG BOX is
// in the cart, which is why it is safe for the blocked state to hand it to someone
// who originally picked a base game.
export const BIGBOX_DISCOUNT_PARAM = true;

// What each offer puts in the cart, and whether the discount code applies to it.
const CART_CONTENTS = {
  "base-kraken": (ed) => ({ items: [BASE_VARIANTS[ed], GIFT_KRAKEN], discount: true }),
  "base-coins": (ed) => ({ items: [BASE_VARIANTS[ed], GIFT_COINS], discount: true }),
  "bigbox-both": (ed) => ({
    items: [BIGBOX_VARIANTS[ed], GIFT_KRAKEN, GIFT_COINS],
    discount: BIGBOX_DISCOUNT_PARAM,
  }),
};

/**
 * What one offer + edition puts in a cart.
 *
 * Returns null for anything it does not recognise, so callers have to notice, and
 * the items already carry the quantity Shopify's Ajax cart wants. Both the permalink
 * below and the browser-side cart loader in public/lp-aboard-cart.js read this, so
 * the link somebody clicks and the cart the page builds hold the same three items.
 *
 * @param {string} offer   one of OFFERS
 * @param {string} edition one of EDITIONS
 * @returns {{items: {id: string, quantity: number}[], discount: boolean}|null}
 */
export function cartItems(offer, edition) {
  const build = CART_CONTENTS[offer];
  if (!build) return null;
  if (!EDITIONS.includes(edition)) return null;

  const { items, discount } = build(edition);
  if (items.some((id) => !id)) return null;

  return { items: items.map((id) => ({ id, quantity: 1 })), discount };
}

/**
 * Build the Shopify cart permalink for an offer + edition.
 * Returns null for anything it does not recognise, so callers have to notice.
 *
 * This link is the FALLBACK, not the main road. On this store it 302s into Shop Pay
 * checkout instead of stopping at the cart, which skips the upsells that live on the
 * cart page - verified against the live store on 2026-08-05. The page loads the cart
 * with the Ajax cart API instead (public/lp-aboard-cart.js) and only falls back to
 * this link when that does not go through. The claim endpoint still returns it, so a
 * visitor whose cart could not be loaded still has one working way to buy.
 *
 * The code MUST be the one that belongs to this offer. The two base offers share
 * KRAKEN-A7F2; the BIG BOX has its own FULLHOLD-B642. They are separate BXGY rules
 * in Shopify - the base rule grants one free gift, the BIG BOX rule grants both -
 * so putting the BIG BOX code on a base cart hands over a gift we did not offer.
 * The codes live in the claim endpoint, never in this file and never in the page.
 *
 * @param {string} offer   one of OFFERS
 * @param {string} edition one of EDITIONS
 * @param {string} code    discount code for THIS offer, from the claim endpoint
 * @returns {string|null}
 */
export function buildCartUrl(offer, edition, code) {
  const cart = cartItems(offer, edition);
  if (!cart) return null;

  const { items, discount } = cart;

  if (discount && !code) {
    // Better a cart with no discount than a cart with the wrong one, but this is
    // a wiring mistake and somebody needs to see it.
    console.error(`[offer] ${offer} takes a discount code but none was given, link built without it`);
  }

  const path = items.map(({ id, quantity }) => `${id}:${quantity}`).join(",");
  const query = discount && code ? `?discount=${encodeURIComponent(code)}` : "";
  return `${SHOP_ORIGIN}/cart/${path}${query}`;
}
