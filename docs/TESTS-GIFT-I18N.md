# The gift page's language and one-choice tests: what they pin and why

`tests/lp-aboard-i18n.test.ts` covers the language-switch work on the gift page: the
five nav chips are a real language switch, and a successful claim shows the visitor
their code before it takes them to the cart.

It comes straight off Lucas's two asks. All five chips translate every visitor-facing
string, including the states the page renders after the form comes back, and the same
click picks the physical edition we ship. What happens to the CART afterwards is
`tests/lp-aboard-cart.test.ts`; the page harness both files drive is
`tests/page-harness.ts`.

The sections below follow the file from top to bottom.

## Helpers

### The page's own offer table (`cartItems`)

The file imports `cartItems` from `lib/offer.js`: the page's own table of what an offer
plus an edition puts in a cart. Asserting against it rather than against a copy is what
keeps these tests about the pairing the page is supposed to keep, instead of about
variant ids the test would then own a second copy of.

### `restoreFromCache`: the Back button onto a frozen page

It stands for the Back button onto a page the browser had frozen. Nothing re-runs: the
document comes back exactly as it was when it left, which is why anything the flow left
behind on it is still there. The one thing a browser does say is the `pageshow` event,
with `persisted` set to mark the document as the frozen one rather than a fresh load.
The page listens for none of it, and these tests are how that stays a choice: what the
page hands back has to be usable before anybody presses Back.

`persisted` is defined by hand because this DOM has no PageTransitionEvent of its own.

## The five tables

### The English table and the markup say the same thing

The page has to read correctly before the language module runs, and if it never runs.
That only holds while the English table and the markup agree, so changing the copy in
one and not the other is a failure rather than a silent drift.

### All five tables hold exactly the same keys

The lead for the cart-failure panel that has lost its cart link
(`state.cartFailedRetired.lead`) is checked by name rather than left to the key
comparison. That comparison is English against itself for the other four and would go
on passing if this line were dropped from all five at once. The whole point of this lead
is that the five tables moved together.

### Switching away from English leaves no English behind

The community reviews are quotes from named people who wrote them in English, and the
line above them says they are unedited. Translating those would make that sentence
false, so they stay as their authors wrote them.

## The blocked flow

### The BIG BOX branch moves the page onto the box it sells

This choice is called "Give me the BIG BOX in English" and there is no other edition of
it on offer, so taking it moves the whole page onto that box: the picker, the chips and
the words with them. It used to leave a visitor reading German while the cart filled
with the English BIG BOX, which is the disagreement this page exists to make impossible.
Losing the German words is what that costs, and it is the honest way round: the page
they are looking at is the box they are buying.

### No language promises the inbox on the BIG BOX branch

The code we email this visitor is the Base Game one they were issued, not the BIG BOX
one, so no table may say otherwise. The test reads off the copy rather than off a
rendered panel: that branch only ever renders in English now, and the promise has to be
absent from all five. Each word in `INBOX` is the one that language's own code state
uses for the inbox.

## The code before the cart

These tests are both halves of Lucas's first ask at once: the code is visible and
readable, and the screen that shows it is in the language the visitor was reading.

There is one test per language rather than a loop over both. Each of them waits out the
real `CODE_VISIBLE_MS` hold, so a loop of two spends over 5000ms in a single test body
and trips bun's default per-test timeout. The hold is the thing under test and does not
get shortened for the test's convenience; the test is split so each one waits once, and
says how long it is allowed to take.

## The hold during a claim

A claim is posted with the edition that was chosen when the button was pressed, and the
answer comes back some unknown time later. Everything in this section is about that
gap: the box the visitor is looking at and the box being put in their cart are one
choice, and a tap that lands during the wait must not be able to pull them apart.

### A chip tapped while the claim is in flight

The visitor taps FR while the answer is still in the air. The tap is dispatched
whatever state the chip is in: what this test is about is where the page ends up, not
which mechanism keeps it there.

### The edition radios are held with the chips

The chips are not on screen at all below 720px, so the radios are the whole language
control on a phone. Holding one end and not the other would leave the race exactly where
it was for most visitors.

## What is left after the wait

The hold covers the wait for the answer. The tests in this section are about what is
left over once that wait is done: a cart that would not build leaves a retry on screen
and a fallback link beside it, both of them made for a decision the visitor took a
minute ago, and a cart that DID build leaves a page the browser can hand back.

### A retry carts the box the page is showing

The chip tap is dispatched whatever state the chip is in, for the same reason as the
in-flight race test: this is about where the page ends up, not about which mechanism
keeps it there.

The box that is kept is the one the claim was made for. It has to be that one rather
than the chip's: only the endpoint knows where the visitor is, and it agreed to ship THIS
edition to them.

### The fallback cart link on that panel is the box on screen too

This is the other way off the same panel. The link carries the variant in its url, so a
link pointing at another edition than the page is the same disagreement with a slower
fuse: the visitor clicks it a minute later and buys a box the page never showed.

### A page restored from the browser's cache comes back usable

The cart was built and the page took the visitor to it. They press Back, and the browser
hands them the frozen document rather than running any of this again. So whatever was
still held when the page left is still held now, and there is nothing running that could
ever release it.

### A page that took two tries to build its cart

Each attempt takes the hold over from the one before it rather than stacking a new one
on top of it. Stacked, they would not all be let go by the time the page navigates, and
a visitor who had to press the button twice would be the one who presses Back onto the
dead page of the previous test.

### A page left through the fallback cart link

This is the other way off the cart-failed panel. The retry stays on this page, but the
link beside it goes to the shop, and the browser freezes this document on the way out
exactly as it does for the redirect. A hold still standing at that moment is a hold that
comes back standing, on a page with nothing left running to release it.

### A retry pressed on a page that came back

This is what the fallback-link test buys, and what it costs. Handing the choice back at
the link means the page that comes back carries a retry AND a picker the visitor can
move, so the two can be pointed at different boxes for the first time since the claim
was made. Pressing the button then has to answer the question this whole page is built
around: which of the two wins.

The claim does. It is the box the endpoint agreed it could ship to this visitor, and it
is what both codes were issued against, so the page comes back to it rather than the
cart following the chip. It is the same answer `takeEdition` already gives on the
blocked road, and the visitor sees it: the words and the picker move back together
before the cart is built.

The final assertion is the claim every other test on this page makes, at the one moment
it was still possible to break it: whatever the page ends up showing is what is in the
cart. Both halves are read off the page, and checked against the page's own offer table
rather than a copy of it, so the test says what the cart holds and not what I expected
it to.

### A visitor who started over instead of retrying

This is the third road off the cart-failed panel, and the only one that is not a button
on it. The form is still up the page and the submit button is live again, so a visitor
can walk away from the attempt waiting for them by starting a fresh claim. The abandoned
attempt's hold has to go with it: left behind, it rides the new claim's page into the
browser's cache and Back hands back a page nobody can use.

### A page left with a retry still waiting

This is the departure that is nobody's exit in particular: the privacy link under the
submit button, the nav, a bookmark. Nothing about the attempt is resolved by any of
those, so unlike the fallback cart link they hand nothing back, and the hold is right to
be standing again on the way in. This is the case a blanket release on `pageshow` would
break rather than fix.

## The roads to a cart

Three more roads to a cart, all of them older than the language work: the stale fallback
link comes from 96a5c04, both blocked mismatches from 8d23637. They are the same shape as
everything above (a cart built from a choice the visitor is no longer looking at) and
they are the reason the page now moves itself onto the box it is about to cart instead
of each road remembering to hold the controls still.

Each test reads both halves off the page and compares them against the page's own offer
table, so it says what the cart holds rather than what I expected it to.

### `cartRoads`: every road out of the document that ends on a shop cart

An href, not a listener. A browser follows an anchor by ways that reach no JavaScript at
all: the middle button, Ctrl or Cmd with a click, Open in new tab out of the context
menu, the keyboard's own menu key. A test that clicked the link would be checking the one
road that DOES reach a listener and calling the class covered, so nothing that uses
`cartRoads` clicks it. It reads off the whole document rather than off the panel, because
an anchor anywhere is a road a visitor can walk.

It reads the attribute rather than the resolved property, because the page writes an
absolute shop url and every other anchor here is an in-page `#offer`. This DOM resolves
those against the document url, which the click in the retirement test moves onto the
shop's cart, so reading the property would report the whole nav as roads to a cart. A
real browser leaves the frozen document with the url it had.

### `noRoadDisagrees`: the property, over the whole document

Nothing on this page is a road to a cart that disagrees with what the page is showing. A
road that agrees and no road at all both satisfy it, which is deliberate. It says what
the visitor may end up with, not how the page arranges for it.

### `LEAVING_THE_CLAIM`: either control retires the link

Either control moving takes the page off the claim, so either one has to retire the link.
The gift is the half that redraws nothing: a language change repaints the panel around
the visitor and a gift change does not, so a page that only checked its own repaints
would keep the link standing there and look fixed from the other end.

In the test that loops over it, `no_redirect` hands over the code with its fallback link
beside it and lets go of both controls, so this is a panel the visitor can sit on and
change their mind next to. Nothing is clicked on the link and nothing has to be: the
disagreement is in the href, and every way a browser has of following an href is a way
that never reaches the correction hanging off its click.

### The fallback link is retired when the page leaves the claim, and the retry is not

The cart would not build, the visitor left through the fallback link, and Back handed
them the frozen page: the hold went out of the door with them, so that panel is on screen
with both controls free beside it. The click on the link is how the page gets into that
state; it is the setup, and the test is everything after it.

The other road off this panel, the retry, stays, because it cannot disagree: it goes back
through the page, which puts the claim on screen before anything is built. It is also the
recovery path a visitor needs precisely when the shop's cart is what broke.

### The panel stops naming a cart button it no longer has

`CART_BUTTON` holds what that panel SAYS once its link has gone. Each entry is the phrase
that language's own cart-failure lead uses for the button, so the assertions are about
the sentence a visitor reads and not about a key having changed.

The lead on this panel ends by pointing at the link beside it. The link retires when the
page moves off the box it carts, and a line telling the visitor to press a button that is
not there is the panel describing itself wrongly. Two languages are tested, because all
five tables carry that sentence and all five had to move.

The visitor goes out through the link and back, which is how this panel ends up on
screen with the controls free beside it: the hold left with the page and came back
released. The click is awaited, because following the link leaves the panel to redraw
itself one task later, and a test that read the panel before that would be reading it
mid-move.

Then the gift moves, so the link is retired. The gift rather than the language on
purpose: it repaints nothing, so the lead has to be corrected where the link is taken
away and not on the way back through a repaint.

### The fallback cart link carts the box the page is showing, even after Back

The cart would not build, the visitor left through the fallback link, and Back handed
them the frozen page: the hold went out of the door with them, so both controls are
theirs again with that panel still on screen. This test is that panel with nothing moved
on it, which is the state the link is meant to be taken from: it carts what the page is
showing, and taking it works, because it is their road to the shop.

The visitor moving a control first is the retirement test. That road closes rather than
correcting itself, because an href is followed by ways no listener ever sees.

### Taking the BIG BOX moves the page onto the box it carts

The blocked panel is read in whatever language the visitor switched to, and the BIG BOX
it offers is the English one: "Give me the BIG BOX in English". So taking it has to move
the picker and the language as well as the cart. Left behind, the page shows the German
base game while the cart holds the English BIG BOX.

### Taking a European edition moves the gift back to the one that was claimed

This is the case where the gift radio moves while the blocked panel is deciding, driven
the way it was first reproduced: a real cart rather than the demo link. The gift radios
are the visitor's again while they answer this panel, because the panel is asking about
editions and the gift is not part of the question, so the picker can be pointing at
another box by the time they choose.

The claim wins. The code they were issued is the Base Game rule and the BIG BOX is a
different one, so the page comes back to the base game rather than the cart following
the box they tapped. The original report weighed holding the gift dim throughout against
reading it off the page at the end; this is neither. The gift moves back at the moment
they commit, visibly, which is the same answer every other road gets.

### Switching language after a code is issued

The claim is already made. The words follow the visitor, and the cart the code was
issued against does not move under them: this link is never re-pointed at the picker,
because the endpoint ruled on the box in it and a European re-aiming themselves at the
English Base Game is the one combination it refuses.

This test used to assert the link's href was still the one it started with, which is the
other half of the same sentence and was the wrong half to keep. An unchanged href on a
page that has changed is a road to the box they claimed sitting on a page showing the box
they are looking at, and no click is needed to walk it. So the href does not move, and
the link does not stay.
