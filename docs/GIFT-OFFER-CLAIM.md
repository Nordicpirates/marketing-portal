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

## Where the English Base Game is not sold

`EUROPE` is the EU 27 plus the rest of the EEA (IS, LI, NO). The EU warehouse has no
English Base Game, so that one edition is not sold into those countries. Britain is NOT in
the list: Zatu in Norwich stocks it.

`UNPLACEABLE` is what the trusted hop says when it cannot place the visitor. An empty
string is a half-configured Worker; XX and T1 are Cloudflare's own, and it uses them for an
address that maps to no country and for a Tor exit node. All three mean "we do not know",
and none of them is in `EUROPE`, so believing them as countries would sell the English
base game to exactly the visitor we decided not to guess about.

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

The English Base Game is the one combination we cannot ship into Europe. If the trusted
hop cannot tell us where the visitor is, we do not know whether this is allowed, and the
honest answer to "we do not know" is not "yes". It used to read as "not in Europe" and sold
them a box that would never arrive. Unknown lands on blocked, which offers the BIG BOX
instead: worst case someone outside Europe is offered the wrong thing and can pick another
edition, rather than being charged for something we cannot send.

"Cannot tell us" is more than a missing header: see `UNPLACEABLE` above. A country code
that is not a country is the hop saying it does not know, in its own words.

Only this combination is affected. A known country, any other edition and the BIG BOX all
behave exactly as before.

When this happens the log says which of the two it was, and not the header itself:
countries stay out of the log like everything else identifying. A blank means the Worker
is not forwarding the header at all; a code that is not a country means it is forwarding
an answer Cloudflare could not give, and those need different people to fix them.

## The blocked state and its codes

The code issued for what they picked is the one that gets emailed, and for a blocked
visitor it stays valid for the Base Game in any other edition - what the blocked copy
calls "your original code".

The blocked state does not offer what they picked, it offers the BIG BOX in the same
edition, and a Base Game code does not fit a BIG BOX cart. So the blocked state shows the
BIG BOX code and the cart link carries it. Every other state shows and links the offer
they actually chose.

## What is stored

Every submission is stored, blocked ones included. Blocked people still asked for a code,
and Bengt still needs to mail it to them.

Both codes are stored (`code`, the one issued, and `shownCode`, the one on screen) because
they rotate and the emailer reads this file later, so it cannot re-derive them.

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

## The answer: `code`, `cartUrl` and `baseCode`

`code` and `cartUrl` always describe the state being shown, so they agree with each other.
The page rebuilds the same link from the same shared module (`lib/offer.js`), so if these
two ever disagree it is a bug in one of the two callers, not a mismatch the visitor can end
up clicking. A missing cart url is logged as an error pointing at `lib/offer.js`.

A blocked visitor is no longer handed one answer. The page asks them whether they want the
same game in a language we can send or the BIG BOX in English, and each of those needs a
different code: a Base Game cart wants the code they were issued, a BIG BOX cart wants the
BIG BOX one. Both are already decided here, so the answer carries both rather than the page
guessing or a second request going out.

`code` and `cartUrl` mean exactly what they always did - the code and the cart of the BIG
BOX this state offers - so nothing that reads this answer today changes. `baseCode` is the
addition: the code this visitor was issued and will be emailed, the same value stored as
`code` in the signup row. It rides along only on a blocked answer, because that is the
only state with a choice left in it.
