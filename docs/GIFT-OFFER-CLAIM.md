# The gift offer's claim: what `handleClaim` decides, and why

`handleClaim` in `lib/lp-aboard.ts` answers `POST /lp/aboard/claim`. Before any of what
follows, it refuses a request that did not come through the Worker
(`docs/GIFT-OFFER-WORKER.md`). What goes in the email per state is `docs/GIFT-EMAIL.md`.

## One code per offer

There is one code per offer, because they are two different Shopify BXGY rules: buying a
base game grants one free gift, buying the BIG BOX grants both. A single shared code would
let someone buying a base game claim both gifts.

The codes are rotatable without a code change: set `GIFT_CODE_BASE` / `GIFT_CODE_BIGBOX`
in Studio settings. The page never hardcodes either - it only shows the one code this
endpoint sends back, which is always the code for the offer that state is selling.

## Where the English Base Game is a pre-order

Nothing is refused any more (the owner approved this on 2026-10-14). The English Base Game
(offers `base-kraken` and `base-coins`, edition `en`) is sold from US stock only in the
countries in `EN_BASE_FROM_STOCK` in `lib/offer.js`: US, CA, AU and NZ. It is the same list
as `FROM_STOCK` in `nordicpirates.com/lp/lp-market.v1.js`, and the two change together.
Everywhere else, Britain and the whole of Europe included, it is the new print on
pre-order, variant `54235343880539`, and `handleClaim` answers with `preorder: true`.
`enBasePreorder(country)` is the one place that decides it.

`UNPLACEABLE` is what the trusted hop says when it cannot place the visitor. An empty
string is a half-configured Worker; XX and T1 are Cloudflare's own, and it uses them for an
address that maps to no country and for a Tor exit node. All three mean "we do not know",
and none of them is on the stock list, so they land on the pre-order like any other
country the stock does not cover: the pre-order print ships anywhere.

## Rate limit

Ten submissions per IP per hour. The map is in memory and this process runs for weeks, so
once it holds more than 5000 IPs, IPs whose window has fully expired are dropped rather
than growing the map forever.

## Reading the body

`readBody` accepts both JSON (what the page sends) and a plain form post. A body that is
not valid JSON, or not a readable form, is logged and read as empty, which then fails the
field checks below.

## What is refused, in order

1. **Rate limited:** 429.
2. **The honeypot** field `company` is invisible to humans, so anything in it is a bot:
   400.
3. **Any `action` field at all:** 400, and no action is ever stored. This endpoint proves
   nothing about who owns the address it is given, so it must not carry an instruction
   about somebody's mailing list. Anyone could post a victim's address and have us write
   down that they asked to be re-subscribed. Refusing every action leaves the Brevo job
   downstream nothing here it could mistake for consent. Putting people back on a list
   needs a confirmed-email flow, which is not this.
4. **Invalid fields:** 400, with only the field names in the log. The values are attacker
   controlled and one of them is an email address, so neither belongs in a log line.
   - The email check is deliberately loose: something@something.tld. Anything stricter
     starts rejecting real addresses, and the real proof an address works is the email
     that follows.
   - RFC 5321 caps a forward path at 254 characters. Anything longer is not an address
     anyone owns, and without a cap it is a free way to pad the JSONL store.
   - The offer and edition must be ones `lib/offer.js` knows.

## The English Base Game when the country is unknown

If the trusted hop cannot tell us where the visitor is, the English Base Game is sold as the
pre-order print. It used to land on a blocked state, because the old stock could not go
into Europe and "we do not know" is not "yes". The pre-order print has no such limit, so
the unknown visitor gets a code and a cart that will arrive.

"Cannot tell us" is more than a missing header: see `UNPLACEABLE` above. A country code
that is not a country is the hop saying it does not know, in its own words.

Only this combination is affected. Any other edition and the BIG BOX are never a pre-order,
whatever the country.

When this happens the log says which of the two it was, and not the header itself:
countries stay out of the log like everything else identifying. A blank means the Worker
is not forwarding the header at all; a code that is not a country means it is forwarding
an answer Cloudflare could not give, and those need different people to fix them. The
visitor is still served, and the log line is what tells the fixer that the stock countries
(US, CA, AU, NZ) are being sold the pre-order print by mistake.

## One state, one code

The answer is always state `code`, with the code for the offer they chose: `KRAKEN-A7F2`
for either base game, `FULLHOLD-B642` for the BIG BOX. That code is the one emailed, and
`preorder: true` rides along only when the cart holds the pre-order print. There used to be
a `blocked` state that offered the BIG BOX instead and carried two codes; the endpoint no
longer produces it, although `public/lp-aboard.js` still knows how to draw it and rows from
before 2026-10-14 still carry it (`docs/GIFT-EMAIL.md`).

The KRAKEN-A7F2 rule in Shopify counts the pre-order product as well as the stock Base Game
since 2026-10-14, so the free gift applies to either cart.

## What is stored

Every submission is stored. `state` is `code`, and `preorder` is true on the rows where the
cart held the pre-order print, so Bengt can tell the visitors who are waiting for a box from
the ones who are not.

`code` and `shownCode` are both stored, and they are the same value now. They stay two
fields because they rotate and the emailer reads this file later, so it cannot re-derive
them, and because older rows can still differ.

`record()` appends one submission to the JSONL store and returns false if it did not land.
The caller must not answer with a code when it returns false. The page tells people the
code is also on its way to their inbox, and the only thing that makes that true is this
file: the emailer reads it and nothing else. A code on screen with no row in the file is a
promise we have already broken. So when the write fails, the answer is a 503 asking them
to try again: saying "your code is on its way to your inbox" would be a lie, and handing
over a working code we have no record of issuing is worse.

## Logs carry nothing identifying

Logs go to the container log, which is a far looser thing than the signup file: it is
shipped around, tailed in chat, and kept for as long as nobody prunes it. So nothing
identifying goes in one. No email, no country, no IP, no discount code, no honeypot value,
no raw request body. Only what the endpoint DID.

Every stored submission gets an event id that goes into both the log line and the JSONL
row, so a line in the log can be tied back to its record by whoever is allowed to open the
protected file. The file stays the record; the log is only ever a trace of what happened.

## The answer: `code`, `cartUrl` and `preorder`

`code` and `cartUrl` always describe the state being shown, so they agree with each other.
The page rebuilds the same link from the same shared module (`lib/offer.js`), so if these
two ever disagree it is a bug in one of the two callers, not a mismatch the visitor can end
up clicking. A missing cart url is logged as an error pointing at `lib/offer.js`.

`preorder` is present, and true, only when the cart holds the pre-order print. The page
passes it into `buildCartUrl`, `loadCart` and the fallback cart link, so the link it builds
and the cart it loads are the ones the endpoint described. There is no `baseCode`: with one
choice there is one code.
