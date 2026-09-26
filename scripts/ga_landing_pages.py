#!/usr/bin/env python3
"""Landing pages per period from GA4, straight into data/snapshot.json.

Run from the repo root. Reads every period's own range out of the snapshot, asks GA4 for
sessions and purchases per landing page, and writes periods[].landing_pages plus the
sources.landing_pages date. Docs: docs/FRESHNESS.md, docs/DAILY-REFRESH.md.

  python3 scripts/ga_landing_pages.py [--property 250338585] [--top 8] [--dry-run]

GA4 is reached through `gate ga report`, so the credentials stay in GATE.
"""

import argparse
import collections
import json
import subprocess
import sys
from datetime import date

# The dimension WITHOUT the query string. landingPagePlusQueryString splits one campaign
# page across every fbclid it was ever hit with, which hides the busiest pages entirely.
DIMENSION = "landingPage"
METRICS = "sessions,ecommercePurchases"

# Friendly names for the paths we know. Anything else is shown as its own path.
NAMES = {
    "/": "Homepage",
    "/products/lying-pirates-base-game": "Base Game (product)",
    "/products/lying-pirates-big-box": "Big Box (product)",
    "/products/lying-pirates-upgrade-box": "Upgrade Box (product)",
    "/products/lying-pirates-custom-insert": "Custom Insert (product)",
    "/products/gold-coins-20-pcs": "Gold Coins (product)",
    "/products/lying-pirates-cities-of-greed": "Cities of Greed (product)",
    "/pages/newslettersignup": "Newsletter signup",
    "/pages/faq": "FAQ",
    "/pages/about-us": "About us",
    "/pages/contact": "Contact",
    "/collections/all": "All products",
    "/search": "Search",
    "/cart": "Cart",
    "/gift-offer": "Gift offer (LP)",
    "/lp/lying-pirates-cities-of-greed-big-box": "CoG Big Box LP (A)",
    "/lp/lying-pirates-cities-of-greed-big-box-b": "CoG Big Box LP (B)",
    "/lp/play": "Big Box LP (play)",
    "/lp/lying-pirates-it": "Lying Pirates LP (IT)",
    "/lp/lying-pirates-cities-of-greed-big-box-it": "CoG Big Box LP (A, IT)",
    "/lp/lying-pirates-cities-of-greed-big-box-b-it": "CoG Big Box LP (B, IT)",
    "/lp/lying-pirates-cities-of-greed-big-box-de": "CoG Big Box LP (A, DE)",
    "/lp/lying-pirates-cities-of-greed-big-box-b-de": "CoG Big Box LP (B, DE)",
    "/products/cities-of-greed": "Cities of Greed (product)",
    "/products/kraken-mini-expansion": "Kraken Mini (product)",
    "/collections": "Collections",
    "/collections/lying-pirates": "Lying Pirates (collection)",
    "/pages/sticker-fix": "Sticker fix",
    "/blogs/news": "Blog",
}

# GA4's own word for a session it could not place on a page. Not a page, so not a row.
NOT_A_PAGE = {"(not set)", "(other)", ""}

# A page with real traffic and almost no purchases is worth the red bar on the page.
ALERT_MIN_SESSIONS = 200
ALERT_MAX_CONV_PCT = 1.0


def ga_rows(prop, start, end, top):
    """sessions and purchases per landing page, busiest first."""
    out = subprocess.run(
        ["gate", "ga", "report", "--property", prop, "--metrics", METRICS,
         "--dimensions", DIMENSION, "--start", start, "--end", end, "--limit", str(top * 4)],
        capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        raise SystemExit(f"gate ga report failed for {start}..{end}: {out.stderr.strip()[:400]}")
    payload = json.loads(out.stdout)
    if not payload.get("ok"):
        raise SystemExit(f"gate ga report answered not-ok for {start}..{end}: {json.dumps(payload)[:400]}")

    totals = collections.defaultdict(lambda: [0, 0])
    for row in payload["data"].get("rows", []):
        path = row["dimensionValues"][0]["value"].strip()
        if path in NOT_A_PAGE:
            continue
        # Trailing slashes are the same page to a reader, so they are one row here too.
        key = path.rstrip("/") or "/"
        values = row["metricValues"]
        totals[key][0] += int(values[0]["value"])
        totals[key][1] += int(values[1]["value"])
    return totals


def page_rows(totals, top):
    rows = []
    for path, (sessions, purchases) in sorted(totals.items(), key=lambda kv: -kv[1][0])[:top]:
        conv = round(purchases / sessions * 100, 2) if sessions else 0.0
        row = {
            "name": NAMES.get(path, path),
            "path": path,
            "sessions": sessions,
            "conv_pct": conv,
        }
        if sessions >= ALERT_MIN_SESSIONS and conv < ALERT_MAX_CONV_PCT:
            row["alert"] = True
        rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--property", default="250338585")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    path = f"{args.repo}/data/snapshot.json"
    snap = json.load(open(path), object_pairs_hook=collections.OrderedDict)

    newest = None
    for period in snap["periods"]:
        totals = ga_rows(args.property, period["range_start"], period["range_end"], args.top)
        rows = page_rows(totals, args.top)
        print(f"{period['id']:<10} {period['range_start']}..{period['range_end']}  {len(rows)} pages, "
              f"top: {rows[0]['name']} {rows[0]['sessions']}" if rows else f"{period['id']}: no rows")
        period["landing_pages"] = rows
        newest = max(newest or period["range_end"], period["range_end"])

    snap["sources"]["landing_pages"] = {
        "as_of": newest,
        "pulled": date.today().isoformat(),
        "note": f"GA4 property {args.property}, sessions and purchases per landing page",
    }

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    open(path, "w").write(json.dumps(snap, ensure_ascii=False, indent=1))
    print(f"\nwritten: {path}, sources.landing_pages as_of {newest}")


if __name__ == "__main__":
    main()
