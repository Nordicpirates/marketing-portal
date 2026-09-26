# Daily refresh: Amazon, total sales and the ROAS series

The portal is refreshed once a day by Bengt's signal "Portal daily refresh" (#601). The Meta,
Google and Shopify period figures are written by that run as before. This document covers the
three additions from 26 Sep 2026: Amazon sales in EUR, total sales, and the per-day ROAS series.

## Inputs

1. `data/snapshot.json` as the refresh has already written it (periods, meta, gads, yesterday).
2. Meta per day, account level, last 30 days: a JSON `{"days":[{"date","spend","roas","purchases"}]}`
   in SEK. Source: META ADs MCP `ads_get_ad_entities`, level `ad_account`, fields
   `amount_spent, purchase_roas, omni_purchase`, `date_preset last_30d`, `time_increment "1"`.
3. Shopify per day: `python3 scripts/shopify_daily.py <since> <out.json>` run through
   `gate vault exec --env CID=Shopify_client_ID --env CS=SHOPIFYFULL -- ...`. Stockholm days,
   cancelled orders skipped, EUR.
4. Amazon per day (USD): the Google Sheet "Amazon daily sales (Seller Central) - Nordic Pirates",
   tab `daily`, columns `Date (YYYY-MM-DD) | Orders | Sales USD | Notes`. Filled by hand from
   Seller Central > Business Reports > Sales and Traffic (ordered product sales, by day).
   Export it with `gate gdrive download <sheetId> --out amazon.xlsx` (Sheets export to xlsx).
5. EUR rates: ECB `eurofxref-daily.xml` (USD and SEK per EUR). Fetched by the builder itself.

## The builder

```
python3 scripts/build_snapshot_extras.py --repo . \
  --meta-daily <meta.json> --shopify-daily <shopify.json> [--amazon-xlsx amazon.xlsx]
```

It writes, without inventing any number:

- `fx`: `{usd_per_eur, sek_per_eur, date, source}` from the ECB.
- `amazon`: the merged day rows (`data/amazon-daily.json` is the store; the sheet only adds or
  overwrites rows), `sales_eur` per row at the ECB rate, `as_of`, `pending`, `by_period`,
  `sheet_url`. No rows means `pending: true` and the page shows a dash, never an estimate.
- per period `kpis`: `shopify_sales_eur`, `amazon_sales_eur`, `amazon_sales_usd`,
  `amazon_days_covered`, `total_sales_eur`, `total_label`, `amazon_label`.
- per period `meta.blended_mer_total`: (Shopify + Amazon in EUR) x SEK/EUR over Meta + Google
  spend. Null until Amazon has rows in that period.
- `roas_series`: one row per day for the last 30 days: Meta spend and ROAS, Shopify orders and
  revenue, Amazon revenue (or null), `blended_mer` (Shopify over Meta spend) and
  `blended_mer_total` (with Amazon, when present).

SEK per EUR for the blended figures is read from `currency_note` in the snapshot so the series
and the period cards agree; the ECB SEK rate is stored in `fx` for the day the refresh switches.

## Where it shows

`public/index.html`: the Store performance row (Total, Shopify, Amazon, Orders, Conversion,
Sessions), a sales note with the rate and the sheet link, a fourth Meta stat "Blended incl.
Amazon", and the section "ROAS per day · last 30 days" (Chart.js, spend bars, two or three lines).

## Landing pages (GA4)

```
python3 scripts/ga_landing_pages.py
```

Reads each period's own range out of the snapshot, asks GA4 through `gate ga report` for
sessions and purchases per landing page, and writes `periods[].landing_pages` plus
`sources.landing_pages`. Property 250338585.

Use the `landingPage` dimension, never `landingPagePlusQueryString`: the latter splits one
campaign page across every `fbclid` it was hit with, which is how the two busiest pages on
the site stayed missing from this table for seven weeks.

GA4 purchases undercount against Shopify (consent mode, blockers, iOS), so the conversion
column is GA4's own rate and the page caption says so.

## Still not in this refresh

`inventory_data`, `chart_data.organic_14d` and `channels_30d` are written by hand and are
the sections that go stale. The freshness pills now say how old each one is
(docs/FRESHNESS.md); making them daily is open work.

## Amazon: the honest limits

There is no Amazon API access in GATE. Mailbox shipment notices undercount and FeedbackFive
overcounts (memory note amazon-forsaljning-leveransnotiser-feedbackfive-2026-09-18), so the sheet
is the only trustworthy daily source until Seller Central's SP-API is authorised. Amazon Ads
spend is not in the blended figures; say so when quoting them.

## Amazon through the Selling Partner API (prepared 26 Sep 2026, waiting for Amazon's approval)

`scripts/amazon_spapi_daily.py` pulls the Sales and Traffic Business Report
(`GET_SALES_AND_TRAFFIC_REPORT`, by DAY, US marketplace `ATVPDKIKX0DER`) and writes the same day
rows the sheet gives: `{date, orders, units, sales_usd, sessions}`. It needs the role
**Brand Analytics** on a private, self-authorised app, and three secrets in the vault at org scope:
`AMAZON_SPAPI_CLIENT_ID`, `AMAZON_SPAPI_CLIENT_SECRET`, `AMAZON_SPAPI_REFRESH_TOKEN`.

```
gate vault exec --env AMZ_LWA_CLIENT_ID=AMAZON_SPAPI_CLIENT_ID \
  --env AMZ_LWA_CLIENT_SECRET=AMAZON_SPAPI_CLIENT_SECRET \
  --env AMZ_LWA_REFRESH_TOKEN=AMAZON_SPAPI_REFRESH_TOKEN -- \
  python3 scripts/amazon_spapi_daily.py --days 35 --out amazon_spapi_daily.json
python3 scripts/build_snapshot_extras.py --repo . ... --amazon-json amazon_spapi_daily.json
```

API rows win over sheet rows for the same date (`source: spapi` vs `sheet`); the sheet stays as
the fallback. `--check` only exchanges the refresh token, for the day the credentials arrive.
Not yet run against a live account: Amazon has to approve the developer profile first. The
application steps for Lucas are on the internal page amazon-spapi-ansokan-2026-09-26.
