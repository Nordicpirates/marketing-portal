# The gift-offer email: what goes in it, per state

The gift page at nordicpirates.com/gift-offer stores every submission and promises the
visitor their code "is also on its way to your inbox". This document is what makes that
true, and it is the emailer's contract - the page itself sends nothing.

Rows come from `GET /lp/aboard/signups` (unsent, oldest first) and are marked with
`POST /lp/aboard/signups/mark-sent`. Both need `x-lp-admin-secret`; the plumbing is in
`lib/lp-aboard-admin.ts`.

## A row

```json
{"event":"72cb...","ts":"...","email":"...","offer":"base-kraken","edition":"en",
 "country":"DE","state":"blocked","code":"KRAKEN-A7F2","shownCode":"FULLHOLD-B642"}
```

`code` is the code the visitor was issued for what they picked. `shownCode` is the code the
state they landed on displays.

## state: "code" - send one code

They picked something we can ship and the page showed them `code`. Email that one, and
nothing else. `code` and `shownCode` are the same value on these rows.

## state: "blocked" - send BOTH codes, each labelled with the cart it fits

A blocked visitor asked for the English Base Game inside Europe. The page does not hand
them one answer: it asks whether they want the same game in an edition we can send, or the
BIG BOX in English, and **that choice is made in the browser and never reaches us**. So
`shownCode` on a blocked row means "the code the BIG BOX choice would show", not proof that
anyone took it.

Both codes therefore go in the email, each one named with what it is for:

- `code` (the Base Game code) - for any other edition of the Base Game
- `shownCode` (the BIG BOX code) - for the BIG BOX in English

**Why both is safe, checked against the two rules in Shopify on 2026-09-26.** They are
separate Buy-X-Get-Y discounts, each bound to its own product:

| code | requires | gives |
|---|---|---|
| Base Game code | 1 x Lying Pirates: Base Game | 1 free of Gold Coins / Kraken Mini |
| BIG BOX code | 1 x Lying Pirates: BIG BOX | 2 free of Gold Coins / Kraken Mini |

Neither does anything on the other's cart, so holding both gets nobody a gift they were not
offered. That product binding is also why the Base Game code works on **any** edition,
which is what the blocked copy promises: the rule names the product, not a variant.

Rejected alternatives, and why: having the page report the choice back needs a second
endpoint and still reports nothing for a visitor who closes the tab, so we would be guessing
for some of them anyway. Sending only the Base Game code retracts half of what the page
offered them on screen.

## Do not

- Do not re-derive a code from the offer. The codes rotate through `GIFT_CODE_BASE` and
  `GIFT_CODE_BIGBOX`; the row stores what that person was actually shown, which is the whole
  reason both fields are on it.
- Do not treat a row as consent to any mailing list. The endpoint refuses an `action` field
  precisely so nothing downstream can read one. This email answers a code request and
  nothing more.
- Do not mark a row sent before the send succeeds. The ledger is what stops a second email,
  and a row marked in advance is a person who never hears from us.
