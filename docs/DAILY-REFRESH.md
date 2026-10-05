# Daily refresh of the portal

The portal is refreshed once a day by Bengt's signal "Portal daily refresh" (#601). Every figure
comes from a pull made that morning; nothing is carried over or estimated.

## Run order

1. Pull the raw data listed under Inputs.
2. `scripts/write_periods.py`: the five periods, the yesterday block, orders per country.
3. `scripts/build_snapshot_extras.py`: exchange rates, Amazon, the ROAS series.
4. `scripts/ga_landing_pages.py`: landing pages per period.
5. `scripts/conversion.py`: conversion with all four denominators, and Sessions.

Work in a copy of the checkout under your own home: the shared checkout holds files you cannot
write. Commit, push, and let the webhook deploy.

## Inputs

1. Meta per day, account level, last 30 days: `{"days":[{"date","spend","roas","purchases","value"}]}`
   in SEK. Source: META ADs MCP `ads_get_ad_entities`, level `ad_account`, fields
   `amount_spent, purchase_roas, omni_purchase, omni_purchase_values`, `date_preset last_30d`,
   `time_increment "1"`. Before using it, sum it and compare with Meta's own account total for
   the same 30 days: a transcription slip shows up there and nowhere else.
2. Meta's own account total for the 90-day window (same fields, `time_range`, no increment),
   passed as `--meta-total`. The daily file is 30 days, so this is the 90-day figure.
3. Shopify per day, from 90 days back: `python3 scripts/shopify_daily.py <since> <out.json>` run
   through `gate vault exec --env CID=Shopify_client_ID --env CS=SHOPIFYFULL -- ...`. Stockholm
   days, cancelled orders skipped, EUR, with `by_country` per day.
4. Google Ads, 90 days back to yesterday: `gate gads campaign-metrics --customer 7166732500
   --start <since> --end <yesterday> > gads.json`. Rows carry the day, so one pull serves every
   window.
5. Amazon per day (USD): the Google Sheet "Amazon daily sales (Seller Central) - Nordic Pirates",
   tab `daily`, columns `Date (YYYY-MM-DD) | Orders | Sales USD | Notes`. Filled by hand from
   Seller Central > Business Reports > Sales and Traffic (ordered product sales, by day).
   Export it with `gate gdrive download <sheetId> --out amazon.xlsx` (Sheets export to xlsx).
6. EUR rates: ECB `eurofxref-daily.xml` (USD and SEK per EUR). Fetched by the builder itself.

## Periods

```
python3 scripts/write_periods.py --repo . --meta-daily meta.json \
  --meta-total 90d=<since>:<until>:<spend>:<value>:<purchases> \
  --shopify-daily shopify.json --gads gads.json --gads-since <since> --gads-until <yesterday>
```

Windows end yesterday, Stockholm time: 7 days, 30 days, month to date, 90 days, and yesterday.
It refuses to write when a pull does not cover a window, when a `--meta-total` names other
dates than its window, or when the orders per country do not add up to the period's orders.

- Meta: the daily file when it covers the window, else the `--meta-total` for exactly that window.
- Shopify: orders and EUR per window, and `orders_by_country` by shipping country (billing when
  an order has none), sorted by revenue.
- Google Ads: per window and per campaign. A zero is a zero the pull returned, not an assumption.
- Flags carrying a `date` leave every window that no longer holds that day; undated flags stay.
- It dates the "Alla siffror nyhämtade" status card, `sources.shopify|meta|gads`, `gads.as_of`
  and `gads_periods.until`. Hand-written status cards and flags are not its business.
- It drops any per-period `sources` override: the period is rewritten from this morning's
  pulls, so an override left by an earlier partial run would describe numbers that are gone.

## When Meta cannot be pulled

Pass `--no-meta` instead of `--meta-daily` (and no `--meta-total`) to both scripts. The rest
of the page still refreshes; Lucas chose this on 5 Oct 2026 over a page frozen on old days.

- Every period's Meta block reads `Unavailable`, with ROAS, blended and blended incl. Amazon
  null: blank on the page, never zero, and no older Meta figure is reused.
- `sources.meta` gets `as_of: null`, `text: "unavailable"` and a note naming the last day a
  pull covered (`last_as_of`), so the Meta pill says so in words.
- `roas_series` is left exactly as it was, since every point rests on Meta's spend. Its own
  pill shows its age.
- The status card is titled "Butik och Google nyhämtade <day>, Meta saknas". The next full run
  renames it back to "Alla siffror nyhämtade" and clears the Meta note.

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

## Conversion, all four denominators

```
gate vault exec --env CID=Shopify_client_ID --env SEC=SHOPIFYFULL -- python3 scripts/conversion.py
```

Run it after the periods are written, because it reads each period's orders. It fills
`periods[].conversion`, the Sessions KPI and the conversion label. Why four figures rather
than one: docs/CONVERSION.md.

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
