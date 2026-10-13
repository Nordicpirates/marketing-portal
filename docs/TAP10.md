# The TAP 10 tab

`/tap10` shows what the TAP 10 launch is doing, per Stockholm day since launch on 6 October 2026:
signups, the waitlist, Kickstarter followers and visits, visitors on tap10game.com, ad spend,
video plays and the demo. Lucas asked for it on 13 Oct 2026, verbatim: "ge mig statistik för
tap10game. signups, video-plays, antal på KS sidan, besökare osv osv. kan du lägga in allt sånt
på https://marketing.nordicpirate.com/ som en egen flik?"

## The parts

- `public/tap10.html`, served at `/tap10` through `htmlPage`, with a "TAP 10" tab on every page.
- `GET /api/tap10` serves `data/tap10.json`, no-cache. Not built yet answers `{ "days": [] }`,
  never a 404. `TAP10_JSON` points the server at another file; only the tests set it.
- `scripts/tap10_snapshot.py` builds `data/tap10.json` from files the morning job pulled.
- Tests: `tests/tap10-builder.test.ts`, `tests/tap10-page.test.ts`, `tests/tap10-api.test.ts`,
  all on the hand-made fixtures in `tests/fixtures/tap10` (ids only, no contact data).

## Running the builder

```
python3 scripts/tap10_snapshot.py --repo . \
  --brevo-contacts brevo/ --ga-pull ga.json --ads ads.json \
  --ks-csv /home/shared/lyingpirates/tap10-signups/kickstarter-followers.csv \
  --ks-pageviews pv-1.json [--ks-pageviews pv-2.json ...]
```

The days run from `--since` (default 2026-10-06) to `--until` (default today, Stockholm). Today's
row is marked `partial`. `--dry-run` prints the summary and writes nothing.

Each input can be left out. Its fields are then null and its source says `unavailable`, so the
page shows a dash and the pill says so. Nothing is estimated and no older figure is reused.

It refuses to write (exit 2, nothing written) when:

- a count is negative;
- the ads rows skip a day inside their own span, which would read as no spend;
- a GA report's `rowCount` differs from the rows it returned, or it has rows and no `rowCount`;
- two ads files or two page view files disagree about the same day or hour;
- a Brevo contact has neither `SIGNUP_DATE` nor `createdAt`.

## Inputs

- `--brevo-contacts <dir>`: every page of `gate brevo contacts --max 500 --offset N`, one JSON
  file each, shaped `{"data":{"contacts":[...]}}` or `{"contacts":[...]}`. A contact on two
  pages counts once, by id. `--list-ids` does not filter, so the builder keeps `listIds` with 10.
- `--ga <file>` reads the four raw GA reports. `--ga-pull <file>` asks GA itself through
  `gate ga report --property 542188652` and saves the raw answers there first. A truncated
  report is asked again once with GA's own `rowCount` as the limit, then refused.
- `--ads <file>`, repeatable: `[{date, spend_sek, link_clicks}]` for the Meta campaign
  "YMP - 29 Sept - TAP 10 - Leads -  US/UK", pulled by Polly through the Meta connector.
- `--ks-csv`: `stockholm_time,ks_followers,waitlist,note,polytopia`. Waitlist is ignored: Brevo
  is the count.
- `--ks-pageviews <file>`, repeatable: the raw Meta dataset stats for PageView by host,
  `{"stats":[{"timestamp":"2026-10-06T15:00:00-0700","data":[{"value":"www.kickstarter.com","count":4}]}]}`.

## What each number means

| Field | Meaning | Source |
|---|---|---|
| `signups` | list 10 contacts whose signup day is this day | Brevo, exact |
| `waitlist_total` | list 10 contacts signed up on or before this day, not blacklisted | Brevo |
| `waitlist_blacklisted` | the same, blacklisted (unsubscribed or bounced) | Brevo |
| `ks_followers` | the last reading of the day | the follower CSV |
| `ks_pageviews` | the TAP 10 pixel's PageView on www.kickstarter.com | Meta dataset stats |
| `ks_ga_sessions` | GA sessions on host www.kickstarter.com | GA4 |
| `ga_sessions`, `ga_users` | GA sessions and users on tap10game.com and www.tap10game.com | GA4 |
| `avg_session_sec` | average session length on those two hosts, weighted by sessions | GA4 |
| `ad_spend_sek`, `ad_clicks` | spend and link clicks of the TAP 10 Leads campaign | Meta |
| `film_starts`, `film_completes` | `video_start` / `video_complete` with title "TAP 10 film" | GA4 |
| `reel_starts`, `reel_completes` | the same for titles starting "Reel " | GA4 |
| `demo_starts`, `demo_completes` | `demo_start` / `demo_complete` | GA4 |
| `demo_star_clicks` | `try_demo_click`, the "Try the demo" star | GA4 |

The signup day is `SIGNUP_DATE` when it is a `YYYY-MM-DD`, else `createdAt` in Stockholm time.
Signups by form (`SIGNUP_FORM`) and by placement (`UTM_MEDIUM`, "-" when empty) count signups
from `--since` to `--until`. Videos and GA traffic sources are totals over the same days.

On the page the windows (since launch, 7 days, yesterday) end on the newest whole day, so
today's partial row is in the table and never in a total. Cost per signup divides spend by
the signups of the days that have spend.

## Known limits

- GA only sees visitors who accept cookies, and the cookie box is default-denied for everyone.
  GA visits, video and demo numbers are a floor, not a count.
- Property 542188652 also holds the Kickstarter page. Every GA report carries `hostName` and
  only tap10game.com and www.tap10game.com count as the site; any other host is dropped.
- `ga_users` adds the two tap10game hosts, so a visitor seen on both counts twice.
- GA's newest day is still being processed, so it is marked `provisional`.
- GA days are the property's own time zone, assumed Europe/Stockholm. Not checked against the
  property settings.
- A GA day inside the pulled range with no row is a 0, because GA leaves out empty days.
- The `rowCount` check assumes `gate ga report` passes GA's `rowCount` through. If it does
  not, the builder refuses rather than trust a report that may be cut short.
- KS page views come from the pixel and are an indication, not Kickstarter's own count.
- Cloudflare's cookieless counter exists, but no key can read it yet.
