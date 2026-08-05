// Cart-direct: build the visitor's real Shopify cart from the browser, then land
// them on /cart with their discount code already on it.
//
// Why this exists at all. The old route was the cart permalink
// /cart/<variant>:1,<gift>:1?discount=CODE. On this store that permalink answers 302
// straight into Shop Pay checkout - verified against the live shop on 2026-08-05 - so
// the visitor never sees the cart page, and the cart page is where the shop's other
// offers are. Lucas asked for the cart, so the page has to build the cart itself.
//
// Why it can. The public page is https://nordicpirates.com/gift-offer: the shop's own
// origin, with a Cloudflare Worker rewriting only the /gift-offer/* paths onto the
// portal. Everything here is a bare path, so it goes to Shopify, same-origin, with
// the visitor's cart cookie on it and no CORS in the way. Absolute URLs would turn
// these into cross-origin requests that Shopify's Ajax cart refuses.

import { cartItems } from "./offer.js";

export const CART_PATH = "/cart";
export const CART_CLEAR_PATH = "/cart/clear.js";
export const CART_ADD_PATH = "/cart/add.js";

/**
 * Shopify's discount link. Applies the code to this browser's session and then sends
 * it wherever `redirect` says, so it works as a request AND as a place to navigate to.
 * Both of those matter below.
 */
export function discountPath(code) {
  return `/discount/${encodeURIComponent(code)}?redirect=${CART_PATH}`;
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  // Read it either way: Shopify puts the reason a line was refused in the body, and
  // a status on its own does not say which item the shop would not take.
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`POST ${path} answered ${res.status}: ${raw}`);
  return raw;
}

/**
 * Put the offer in the cart and say where to send the visitor next.
 *
 * Three calls, in this order:
 *   1. /cart/clear.js   this flow owns the cart it is about to build. Without it a
 *                       visitor who already had something in there is taken to a cart
 *                       our code does not fit, and the gift silently does not appear.
 *   2. /cart/add.js     every variant for the offer, in one call, so the cart is
 *                       either complete or untouched rather than half built.
 *   3. the discount link, which puts the code on the session.
 *
 * Never throws. Returns {ok:false} when the CART could not be built, which is the only
 * failure the visitor has to be told about: the caller then keeps the code on screen
 * with a retry instead of navigating to a cart that is not there.
 *
 * A discount call that does not come back ok is not that kind of failure. The same
 * link works as a destination, so the answer becomes "navigate through the discount
 * link" and Shopify applies the code on the way in. Two ways for the code to land,
 * and the visitor is never sent to a cart with no gift in it because a fetch failed.
 *
 * @returns {Promise<{ok: true, url: string} | {ok: false, reason: string}>}
 */
export async function loadCart(offer, edition, code) {
  const cart = cartItems(offer, edition);
  if (!cart) {
    console.error(`[lp/aboard] no cart contents for offer="${offer}" edition="${edition}"`);
    return { ok: false, reason: "unknown-offer" };
  }

  console.log(
    `[lp/aboard] loading cart offer=${offer} edition=${edition} items=${JSON.stringify(cart.items)}`
  );

  try {
    await postJson(CART_CLEAR_PATH, {});
    await postJson(CART_ADD_PATH, { items: cart.items });
  } catch (err) {
    console.error("[lp/aboard] cart could not be built:", err);
    return { ok: false, reason: "cart-failed" };
  }

  if (!cart.discount) return { ok: true, url: CART_PATH };

  if (!code) {
    // A cart with no code hands over no gift. The cart itself is real, so the visitor
    // still goes to it, but this is a wiring mistake and somebody needs to see it.
    console.error(`[lp/aboard] ${offer} takes a discount code but none was given`);
    return { ok: true, url: CART_PATH };
  }

  const link = discountPath(code);
  try {
    const res = await fetch(link, { credentials: "same-origin" });
    if (!res.ok) {
      // The link is not in this line on purpose: it carries the code, and codes stay
      // out of logs on both sides of the wire.
      console.warn(
        `[lp/aboard] discount request answered ${res.status}, landing through the link instead`
      );
      return { ok: true, url: link };
    }
  } catch (err) {
    console.warn("[lp/aboard] discount request never completed, landing through the link:", err);
    return { ok: true, url: link };
  }

  return { ok: true, url: CART_PATH };
}
