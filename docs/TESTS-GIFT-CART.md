# What the cart-direct tests pin, and why

`tests/lp-aboard-cart.test.ts` tests the cart-direct half of the gift page's third UX
round: what happens to the visitor's Shopify cart once a code has been issued.

The shop has upsells on the cart page, so a claim has to end ON the cart page with the
game, the gift and the code already in it. The old cart permalink cannot do that - it
302s into Shop Pay checkout on this store - so the page builds the cart itself with
Shopify's same-origin Ajax cart API and then navigates.

Everything is driven through the real page: the fake fetch answers as Shopify would and
records what it was asked for, and `location.assign` is captured instead of tearing the
document down. The page harness is `tests/page-harness.ts`; the page's in-browser
behaviour is covered in `docs/TESTS-GIFT-PAGE.md`.

## Clear, add, apply the code, then go to the cart

These are the three calls Shopify needs, in the one order that works. Clearing first is
what makes this campaign's cart the cart: whatever the visitor had in there before is not
what our code was issued against.

## Every call goes to a bare path

The page is served from the shop's own origin with a Worker holding only the
`/gift-offer/*` paths. An absolute URL would be a cross-origin request the Ajax cart
refuses, and a `/gift-offer` path would land on the portal.

## The code is on screen before the page moves

Lucas asked for the code to be visible before the redirect, long enough to read. The page
is about to navigate on the visitor's behalf, so a code that flashed past is a code they
never got.

## A box tapped while the claim is in flight

The gift is posted with the box that was chosen when the button was pressed, and the
answer comes back some unknown time later. `CART_FOR` and the tests after it are that gap
from the picker's end: a box tapped during the wait must not be able to leave the page
showing one gift while another one is being carted.

Whatever box the page ends up showing, that is the box in the cart. This is the whole
claim, and it is read off the page rather than assumed so it holds in either direction.

## The wait between a built cart and the redirect

The other half of the same window. The claim is answered and the cart is loaded, but the
page is still holding the code on screen long enough to read, and that wait is the last
place a tap can land before the browser leaves. Everything in the cart is settled by then,
so neither control may move.

## One road to a cart, and one to a cart link

This is what keeps every other test in the file true for a road nobody has written yet.
Two functions on this page can produce a cart, and the page calls each of them exactly
once: the Ajax build inside `completeWith`, which takes what it loads from the page after
`aim` has moved it, and the fallback link inside `render`, which moves the page onto what
it carts when the visitor takes it.

A sixth road that builds its own cart has to add a second call site, and that is this test
failing while it is being written rather than a disagreement somebody finds a round
later. It cannot check that a new call site went through `aim`, only that adding one is
loud.
