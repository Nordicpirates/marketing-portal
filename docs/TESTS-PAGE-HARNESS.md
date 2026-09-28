# The gift page harness: `tests/page-harness.ts`

The real gift page, loaded into a DOM and driven with real events. The page tests
(`tests/lp-aboard-page.test.ts`, `tests/lp-aboard-cart.test.ts`,
`tests/lp-aboard-i18n.test.ts`) all drive the page through it.

## What is faked, and why

Nothing here re-implements the page. The only things faked are the browser pieces a test
process does not have, and each of them is faked so a test can DRIVE it (what the claim
endpoint answers, what Shopify's cart answers, what is on screen, where the page
scrolled, where it navigated), never so the page can avoid it.

## The module copies

`page.js` imports `"./offer.js"`, `"./cart.js"` and `"./i18n.js"`, which the browser
resolves against `/gift-offer/page.js` and the server answers from `lib/` and `public/`.
On disk those files are not siblings, so each test writes its own copy of `page.js`,
`cart.js` and `i18n.js` with those imports pointed at the real files. A fresh filename
per test is also what gets a fresh module: bun caches by path, and this page runs its
setup at import time.

## Timing: `CODE_VISIBLE_MS` and `REDIRECT_TEST_MS`

`CODE_VISIBLE_MS` is how long the page holds the code on screen before it navigates,
read out of the page itself. A test that hardcoded the number would keep passing against
a page that had quietly stopped waiting.

`REDIRECT_TEST_MS` is the per-test timeout for a test that waits out a real redirect.
Pass it as the third argument to `test()`. Bun's default is 5000ms and the page
deliberately holds the code for `CODE_VISIBLE_MS` before it navigates, so a test that
drives one claim to the cart spends most of that default doing exactly what it is there
to check. Saying so per test is what keeps `bun test` green with no flags: a suite that
only passes when it is invoked a particular way is a suite that is red for whoever
invokes it the obvious way. It is derived from the constant rather than typed out, so
raising the hold cannot leave these behind.

`page.until` waits up to 15 seconds, comfortably past `CODE_VISIBLE_MS` in the page: a
successful claim deliberately holds the code on screen for a couple of seconds before it
navigates, so a wait that expired at three seconds would be racing the thing under test.

## Choosing a box: `selectOffer` and `tapOffer`

`selectOffer` chooses one of the boxes, the way a real radio group does it. The checked
ATTRIBUTE is moved as well as the property because this DOM matches `input:checked`
against the attribute rather than against the live state of the radio. A real browser
matches the live state, which is why the page reads its selection with that selector.
Without this, every test would be submitting the box that happens to be checked in the
markup. The change event is dispatched here for the same reason a browser dispatches it
during the click: it fires before the click reaches anything around the radio.

`tapOffer` is a visitor tapping one of the boxes, as a browser would deliver it. Two
halves, and only one of them is the browser's to refuse. A click on a disabled radio
moves nothing: it stays unchecked, and so does the label wrapped around it. The change
event is dispatched either way, because a held control that still acted on the event
would be the same bug wearing a disabled attribute.

`selectOffer` is the other thing entirely: it puts the page into a state a test wants to
start from. Driving a tap with it would force through a control the page has said is not
the visitor's, and the test would be checking the harness instead.

## Holding the claim answer: `page.holdClaim`

Holds the claim answer in the air, and hands back the release. The request still goes
out and is still recorded; only the answer waits. That gap is a real one on a real
connection, and it is where a visitor's next tap lands, so it is the only way to drive
what the page does while a claim is in flight.

## Loading the page: `loadPage`

Loads the real page with a claim endpoint and a cart that answer whatever the test says.
`url` carries the query string, which is how `?no_redirect=1` gets tested.

The browser's own email validation is not what these tests are about, and happy-dom does
not run it, so `checkValidity` on the email field always answers true. The page's own "is
this address usable" question is the endpoint's, and it has its own tests.

## Globals the harness replaces

`loadPage` sets these on `globalThis`, because the page is an ES module and reads them as
bare globals: `window`, `document`, `navigator`, `IntersectionObserver` (the test-driven
`FakeObserver`) and `fetch` (the fake claim endpoint and Shopify cart). Nothing puts them
back: once a page test file has called `loadPage`, they stay replaced for the rest of the
`bun test` run.
