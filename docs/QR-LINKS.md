# Counted QR links

A printed QR code can never change, so it should never point straight at a page. Each
counted code encodes a short link on `qr.nordicpirates.com`; that link counts the scan and
sends the phone on to wherever the registry says, which can change at any time.

```
phone scans https://qr.nordicpirates.com/window
  -> Cloudflare Pages Function (edge/qr)       302 to the destination at once
       \-> after the redirect: POST https://marketing.nordicpirate.com/qr/hit
             -> one line in STATE_DIR/qr-scans.jsonl
staff open https://marketing.nordicpirate.com/qr  -> GET /api/qr -> counts per link
```

## The registry: `data/qr-links.json`

The one list of codes. Both halves read it: the edge bundles it at deploy time, the
portal reads it on every request.

- `base` is the short-link host, `https://qr.nordicpirates.com`.
- `links` are the counted codes: `slug` (the path, lowercase), `name`, `where` it hangs,
  `destination` with its utm tags, `created`, `requested_by`.
- `direct` are older printed codes that go straight to a page. They cannot be counted;
  the page lists them so nobody wonders where their numbers went.

utm tags follow the scheme the SPIEL codes started: `utm_medium=qr`, `utm_source` is the
physical surface (window, flyer, backdrop), `utm_campaign` is the occasion.

## Adding a code, or moving one

1. Edit `data/qr-links.json`, open a pull request, merge. The portal redeploys itself.
2. Deploy the edge, because it bundled the old registry:
   `gate vault exec --env CLOUDFLARE_API_TOKEN=Cloudflare -- env CLOUDFLARE_ACCOUNT_ID=5d9d2bf89549ff30274d4ebe0aa44397 QR_PYTHON=<venv>/bin/python scripts/deploy-qr-edge.sh`
3. Open `https://qr.nordicpirates.com/<slug>` and check where it lands.

Until step 2 runs, a new slug lands on the store's front page and its scans are refused
as an unknown slug. A changed destination keeps the old one until then. Never reuse or
rename a slug that is printed: the code on the wall keeps asking for it.

## The edge: `edge/qr`

A Cloudflare Pages project, `nordicpirates-qr`, with one Function, `functions/[[path]].js`.

- A registered slug answers 302 to its destination with `Cache-Control: no-store`, so
  every scan reaches the Function. Anything else answers 302 to the store's front page:
  a printed code never ends on an error page.
- The scan is reported with `waitUntil` after the redirect is decided, so a slow or
  unreachable portal never holds a phone up. A scan lost that way is logged at the edge.
- Only a person's GET counts. HEAD requests, prefetches, empty user agents and anything
  that looks like a bot or link preview redirect the same way but are not reported.
- `?test=1` reports the scan as a test. The portal stores it apart and shows only the
  time of the latest one, so the whole chain can be checked without adding a scan.
- `public/files/` holds the print files and `public/robots.txt`; `_routes.json` keeps
  both away from the Function.

The Function runs at Cloudflare, not on the GATE server, so a portal restart never
breaks a printed code: it only loses the counts for those seconds.

## What is stored per scan

`{"slug","at","country","device","visitor","test"}`. `at` is the portal's clock when the
hit arrived. `country` is Cloudflare's two-letter guess, `XX` when unknown. `device` is
`ios`, `android` or `other` from the user agent.

`visitor` is the first 16 hex of SHA-256 over the UTC day, the IP, the user agent and
`QR_HIT_SECRET`. The IP never leaves the edge. The same phone gives the same value all
day, so "different phones" counts it once per day, and the next day's value cannot be
linked to it.

## The secret: `QR_HIT_SECRET`

`POST /qr/hit` sits ahead of the staff password, like the gift offer's routes, and opens
only for header `x-qr-hit-secret`. The same value is a GATE site secret on the portal and
a Pages secret on `nordicpirates-qr`. Unset on the portal, every hit is refused with 403
and a startup warning says so; unset on the edge, nothing is reported and every request
logs it. The redirects work either way. How the portal reads and compares it:
`docs/SERVER-SECRETS.md`.

To rotate it: `gate sites secrets set lyingpirates-marketing-portal QR_HIT_SECRET`, then
the same value into `wrangler pages secret put QR_HIT_SECRET --project-name nordicpirates-qr`,
both from stdin.

## The numbers: `GET /api/qr` and `/qr`

Counted in Stockholm days. Per link: `total`, `today`, `last7` (today and the six days
before), `last30`, `daily` (one number per day in `days`, oldest first), `unique`,
`countries`, `devices`, `first_scan`, `last_scan`, `last_test`. A scan log that cannot be
read answers 503, never an empty list. Bad lines are counted in `problems`.

## The print files

`scripts/qr_files.py <out-dir>` writes `<slug>.svg`, `<slug>.png` (100 px per module) and
`<slug>.pdf` (150 x 150 mm, vector) for every counted link, then decodes each one back
through OpenCV, the SVG via `rsvg-convert` and the PDF via `pdftoppm`, and stops if any
of them does not read back as the link. Error correction is Q (25 percent damage): a
window has glare and reflections. The deploy script runs it, so the files on
`qr.nordicpirates.com/files/` always match the registry.

OpenCV's detector misses large, sharp images, which is why it tries several sizes before
calling a file unreadable. The tools need a venv: `segno`, `cairosvg`,
`opencv-python-headless`.
