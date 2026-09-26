# How old is this number: the freshness pills

Every section of the portal that shows a measured number says, next to the heading, when
that number was last true. One global "generated today" over a whole page hid a
landing-page table that had not moved in 48 days, and that is what these pills replace.

## The two halves

`data/snapshot.json` carries a top-level `sources` block: one entry per data source.

```json
"sources": {
  "shopify":       { "as_of": "2026-09-25", "pulled": "2026-09-26" },
  "sessions":      { "as_of": null, "note": "sessions are not in the daily pull, ..." },
  "tracking_ids":  { "as_of": null, "text": "kept by hand", "note": "a reference list, ..." }
}
```

- `as_of` — the last day the data actually covers, as `YYYY-MM-DD`. `null` when there is
  no source at all. Anything that is not an ISO day reads as unknown; it is never guessed.
- `pulled` — the day we fetched it. Informational.
- `note` — why, shown under the pills only when the source is stale or unknown.
- `text` — what the pill says instead of "as of unknown", for a list kept by hand.

`public/freshness.js` turns those into pills and is the only place the age rules live, so
two pages cannot disagree. Served at `/freshness.js`, loaded by index, dashboard and
inventory. Up to 2 days old is green, 3 to 7 amber, over 7 red with the age in days.

## Adding a section, or a source

A page declares which sources a section rests on in its own `SECTION_SOURCES` map, keyed
by the id of an empty `<div>` under that section's heading. Nothing else is needed: the
pills are painted once the data is in.

A new source needs an entry in `sources` and a human label in `LABELS` in freshness.js.
Without the label the pill falls back to the raw key, which is ugly but not broken.

## What has no pill, and why

Sections written by the reader in the browser — the agency action list, the ideas board —
have no pull date to show. Reference lists that are maintained by hand say so with `text`
rather than claiming a date they do not have.

## The rule this exists to enforce

A section whose source has no date says **as of unknown**. It must never fall back to the
snapshot's own `generated_at`: that is the failure this whole mechanism replaces, and
`tests/index-period.test.ts` asserts it for every section on the page.
