# Conversion: which traffic the rate was measured on

Shopify reported 4.68% for the week of 20 to 26 September. The real figure for the same week
was 1.36%. Both are arithmetically correct. They divide by different things, and the portal
now shows all four denominators side by side so nobody has to guess which one they are
reading.

## Why Shopify's figure is high and not wrong

Shopify Analytics counts the sessions its own storefront serves. The landing pages at
`/lp/...` and `/gift-offer` are on nordicpirates.com but served by Cloudflare, not by
Shopify, so Shopify's script never runs on them and those sessions are not in its
denominator. The orders they produce ARE in its numerator, because the customer finishes in
the Shopify cart.

Proof, 20 to 26 September: Shopify's own landing-page report for the week lists `/`, product
pages, `/pages/...` and `/collections/...` and not one `/lp/` page, while GA4 counted 2 185
sessions on those pages. Shopify 877 sessions plus GA4's 2 185 landing-page sessions is
3 062, against GA4's total of 3 013.

## The four figures

| Card | Top | Bottom | Counted or estimated |
|---|---|---|---|
| Real conversion | all Shopify orders | all GA4 sessions | counted |
| Store traffic | orders that started on the shop | GA4 sessions not on a landing page | estimated split |
| Landing pages | orders that started on a landing page | GA4 landing-page sessions | estimated split |
| Shopify reports | all Shopify orders | Shopify's own sessions | counted, wrong bottom |

The two middle cards are a split, not a measurement, and say so on the card. Shopify counts
the orders; GA4 counts only some of them (28 of 41 in that week) but its landing-page share
of the ones it saw is what divides the real orders. That assumes GA4 misses purchases evenly
across sources, which it probably does not: ad blockers are heavier on paid traffic, so the
landing-page rate is more likely understated than overstated.

## Getting it right inside Shopify

There is no supported way to write sessions into Shopify Analytics. The only real fix is to
serve the landing pages from Shopify, as theme templates, so its script runs on them. That
is a rebuild of the pages and it costs whatever they gain from living outside the theme, so
it is a decision rather than a task.

Until then Shopify's conversion figure is a store-traffic figure and should be read as one.

## Refreshing it

```
gate vault exec --env CID=Shopify_client_ID --env SEC=SHOPIFYFULL -- python3 scripts/conversion.py
```

Writes `periods[].conversion`, fills `kpis.sessions` and `kpis.conversion_label`, and dates
`sources.sessions` and `sources.shopify_sessions`. GA4 property 250338585, the `landingPage`
dimension, and ShopifyQL `FROM sessions` for Shopify's own count.
