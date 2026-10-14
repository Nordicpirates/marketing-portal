# What the gift page tests pin, and why

`tests/lp-aboard-page.test.ts` tests what the gift page DOES in a browser: the picker
sends you to the email field, the sticky button follows you down the page and changes job
when you choose, the old reviewer section is gone, and a blocked visitor is asked which cart
they want before any code appears. The claim endpoint no longer returns `blocked`
(`docs/GIFT-OFFER-CLAIM.md`), but the page still handles it, so those tests drive it with
a made-up answer and stay until that panel is removed from `public/lp-aboard.js`.

They come straight off the acceptance criteria of the gift page's second and third UX
rounds. What happens to the CART after a code is issued is the other half of the third
round and lives in `tests/lp-aboard-cart.test.ts` (see `docs/TESTS-GIFT-CART.md`). The
harness both files drive the page with is `tests/page-harness.ts`.

## The header button and the old reviewer section

The header's one selling button is `a.top-cta` (`data-i18n="nav.cta"`, to `#offer`) inside
`header.top`. The `.showcase` section, the `.np-nav-cta` button and the standalone reviewer
section (`#pros`) went in the light rebuild; the press quotes now sit inside the reviews
section at `#bgg-reviews`, which the header links to. Under 560px the header button is
hidden by the stylesheet (the CSS checks are in
`tests/lp-aboard.test.ts`), and the hero button and the sticky button are what sell there.

## Arrow keys through the boxes

A radio group fires a click of its own with detail 0 when the arrow keys move through it.
Treating that as a choice would fling focus to the email field every time somebody tried
to read the second option.

## The European edition choice: the nav chip follows

The nav chip follows the same change as the picker, and this is readable in the test now.
The page finds its current edition with an `input:checked` selector, which this DOM
matches against the checked ATTRIBUTE rather than the live state of the radio, so moving
an edition moves both. It has to: that selector is where the page keeps what the visitor
is looking at, and everything it carts is built from what it answers.

## Answering inside the panel keeps focus inside the panel

Every choice replaces the button that was just pressed. Without somewhere to put focus it
lands back at the top of the document, and a keyboard visitor has to walk the whole page
again to find out what their answer did.

The test puts focus in the email field before it submits, and checks the submit leaves it
there. It used to read `activeElement.id` off the page's `<body id="top">`, which only
passed because the body had an id; the anchor is `main#top` now.

## A blocked answer with no base code

(Only a made-up answer can be blocked now; see the top of this file.)

The language choice needs the code the visitor was issued. Without it the cart it builds
would carry no discount at all, which is a gift silently not given. One honest choice
beats two where the second is broken.

## The choosing step is two product columns

The choosing step is two product columns: the Base Game with a choice of gift inside it,
and the BIG BOX, which is one choice carrying both gifts. Everything the page and the
claim endpoint read off this markup had to survive that move, and the tests in that part
of the file are the parts that would break quietly rather than loudly.

## No id is used twice

Two elements with the same id is a real bug: `getElementById` answers with one of them and
every `for` attribute pointing at it follows suit. Two sets of edition tiles is exactly
the change that could introduce one.

## The warning stays on the Base Game column

The `p.en-warn` note is now a pre-order note. It is the only thing on this page that tells
a visitor the English Base Game outside the US stock countries is the new print on
pre-order, before they submit. The stylesheet shows it for exactly that pairing,
so it has to be inside the form, which is what those rules key off.
