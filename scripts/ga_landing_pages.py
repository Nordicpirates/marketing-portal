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

import lp_names

# The dimension WITHOUT the query string. landingPagePlusQueryString splits one campaign
# page across every fbclid it was ever hit with, which hides the busiest pages entirely.
DIMENSION = "landingPage"
METRICS = "sessions,ecommercePurchases"
# Every page is read before case variants merge, so a small /lp/q4 is never cut off below the top rows.
GA_LIMIT = 2000

# GA4's own word for a session it could not place on a page. Not a page, so not a row.
NOT_A_PAGE = {"(not set)", "(other)", ""}

# A page with real traffic and almost no purchases is worth the red bar on the page.
ALERT_MIN_SESSIONS = 200
ALERT_MAX_CONV_PCT = 1.0


def ga_rows(prop, start, end, limit=GA_LIMIT):
    """[(path, sessions, purchases)] per landing page as GA4 spells it; refuses a report cut short."""
    out = subprocess.run(
        ["gate", "ga", "report", "--property", prop, "--metrics", METRICS,
         "--dimensions", DIMENSION, "--start", start, "--end", end, "--limit", str(limit)],
        capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        raise SystemExit(f"gate ga report failed for {start}..{end}: {out.stderr.strip()[:400]}")
    payload = json.loads(out.stdout)
    if not payload.get("ok"):
        raise SystemExit(f"gate ga report answered not-ok for {start}..{end}: {json.dumps(payload)[:400]}")

    data = payload["data"]
    count = data.get("rowCount")
    if count is None and data.get("rows"):
        raise SystemExit(f"GA4 report {start}..{end} has rows but no rowCount, so truncation cannot be ruled out")
    if (count or 0) > limit:
        raise SystemExit(f"GA4 has {count} landing pages for {start}..{end}, above the {limit} read")

    rows = []
    for row in data.get("rows", []):
        path = row["dimensionValues"][0]["value"].strip()
        if path in NOT_A_PAGE:
            continue
        values = row["metricValues"]
        rows.append((path, int(values[0]["value"]), int(values[1]["value"])))
    return rows


def page_rows(names, totals, top):
    rows = []
    for path, (sessions, purchases) in sorted(totals.items(), key=lambda kv: -kv[1][0])[:top]:
        conv = round(purchases / sessions * 100, 2) if sessions else 0.0
        row = {
            "name": lp_names.name_for(names, path),
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

    names = lp_names.load(args.repo)
    newest = None
    for period in snap["periods"]:
        raw = ga_rows(args.property, period["range_start"], period["range_end"])
        rows = page_rows(names, lp_names.merge(names, raw), args.top)
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
