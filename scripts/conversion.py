#!/usr/bin/env python3
"""Conversion per period, all four denominators, into data/snapshot.json.

Run from the repo root through gate vault exec (Shopify credentials). Docs:
docs/CONVERSION.md, docs/DAILY-REFRESH.md.

  gate vault exec --env CID=Shopify_client_ID --env SEC=SHOPIFYFULL -- \
    python3 scripts/conversion.py [--property 250338585] [--dry-run]

Shopify's own conversion counts only the sessions its storefront serves. The landing
pages are served elsewhere on the same domain, so Shopify never sees them and its rate is
measured on a denominator that is missing most of the traffic.
"""

import argparse
import collections
import json
import os
import subprocess
import urllib.request
from datetime import date

SHOP = "2b988c-3.myshopify.com"

# Paths served off the store: Shopify's analytics never sees a session that starts here.
OFF_STORE_PREFIXES = ("/lp/", "/gift-offer")

# GA4's own words for a session it could not place on a page. Not a page, so not counted.
NOT_A_PAGE = {"(not set)", "(other)", ""}


def shopify_token():
    body = json.dumps({
        "client_id": os.environ["CID"],
        "client_secret": os.environ["SEC"],
        "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request(f"https://{SHOP}/admin/oauth/access_token", data=body,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["access_token"]


def shopify_sessions(token, start, end):
    """Shopify's own session count, or None when it will not answer."""
    query = ("query($q:String!){ shopifyqlQuery(query:$q){ parseErrors "
             "tableData{ columns{name} rows } } }")
    ql = f"FROM sessions SHOW sessions GROUP BY day SINCE {start} UNTIL {end}"
    req = urllib.request.Request(
        f"https://{SHOP}/admin/api/2025-07/graphql.json",
        data=json.dumps({"query": query, "variables": {"q": ql}}).encode(),
        headers={"Content-Type": "application/json", "X-Shopify-Access-Token": token})
    payload = json.loads(urllib.request.urlopen(req, timeout=120).read())
    node = (payload.get("data") or {}).get("shopifyqlQuery") or {}
    if node.get("parseErrors"):
        print(f"  shopifyql refused {start}..{end}: {node['parseErrors']}")
        return None
    table = node.get("tableData")
    if not table:
        return None
    return sum(int(row["sessions"]) for row in (table.get("rows") or []))


def ga_split(prop, start, end):
    """GA4 sessions and purchases, split into off-store landing pages and the store."""
    out = subprocess.run(
        ["gate", "ga", "report", "--property", prop, "--metrics", "sessions,ecommercePurchases",
         "--dimensions", "landingPage", "--start", start, "--end", end, "--limit", "400"],
        capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        raise SystemExit(f"gate ga report failed for {start}..{end}: {out.stderr.strip()[:300]}")
    payload = json.loads(out.stdout)
    if not payload.get("ok"):
        raise SystemExit(f"gate ga report answered not-ok for {start}..{end}")
    tally = collections.Counter()
    for row in payload["data"].get("rows", []):
        page = row["dimensionValues"][0]["value"].strip()
        if page in NOT_A_PAGE:
            continue
        sessions = int(row["metricValues"][0]["value"])
        purchases = int(row["metricValues"][1]["value"])
        tally["sessions"] += sessions
        tally["purchases"] += purchases
        if page.startswith(OFF_STORE_PREFIXES):
            tally["lp_sessions"] += sessions
            tally["lp_purchases"] += purchases
    return tally


def pct(top, bottom):
    return round(top / bottom * 100, 2) if bottom else None


def conversion(tally, shop_sessions, orders):
    """The four rates, and the split that has to be named as an estimate."""
    sessions = tally["sessions"]
    lp_sessions = tally["lp_sessions"]
    store_sessions = sessions - lp_sessions

    # Shopify's orders are the real count; GA4 sees only some of them. Its LP-vs-store
    # SHARE is used to split them, which assumes GA4 misses purchases evenly by source.
    seen = tally["purchases"]
    lp_share = (tally["lp_purchases"] / seen) if seen else None
    lp_orders = round(orders * lp_share, 1) if lp_share is not None else None
    store_orders = round(orders - lp_orders, 1) if lp_orders is not None else None

    return {
        "orders": orders,
        "sessions_ga4": sessions,
        "sessions_shopify": shop_sessions,
        "sessions_landing_pages": lp_sessions,
        "sessions_store": store_sessions,
        "shopify_pct": pct(orders, shop_sessions) if shop_sessions else None,
        "blended_pct": pct(orders, sessions),
        "landing_pages_pct": pct(lp_orders, lp_sessions) if lp_orders is not None else None,
        "store_pct": pct(store_orders, store_sessions) if store_orders is not None else None,
        "ga4_purchases_seen": seen,
        "split_is_estimated": True,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--property", default="250338585")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    path = f"{args.repo}/data/snapshot.json"
    snap = json.load(open(path), object_pairs_hook=collections.OrderedDict)
    token = shopify_token()
    newest = None

    for period in snap["periods"]:
        start, end = period["range_start"], period["range_end"]
        tally = ga_split(args.property, start, end)
        shop = shopify_sessions(token, start, end)
        orders = period["kpis"].get("orders") or 0
        block = conversion(tally, shop, orders)
        period["conversion"] = block

        # The Sessions KPI had no source and showed a dash. GA4 is the only count that
        # includes the landing pages, so that is the one the card carries.
        period["kpis"]["sessions"] = block["sessions_ga4"]
        period["kpis"]["conversion_label"] = (
            f"{block['blended_pct']:.2f}%".replace(".", ",") if block["blended_pct"] is not None else "Unavailable")

        print(f"{period['id']:<11}{start}..{end}  shopify {block['shopify_pct']}%  "
              f"blandat {block['blended_pct']}%  LP {block['landing_pages_pct']}%  butik {block['store_pct']}%")
        newest = max(newest or end, end)

    today = date.today().isoformat()
    snap["sources"]["sessions"] = {
        "as_of": newest, "pulled": today,
        "note": f"GA4 property {args.property}: the only count that includes the landing pages"}
    snap["sources"]["shopify_sessions"] = {
        "as_of": newest, "pulled": today,
        "note": "Shopify's own sessions, storefront only, so the landing pages are not in it"}

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    open(path, "w").write(json.dumps(snap, ensure_ascii=False, indent=1))
    print(f"\nwritten: {path}")


if __name__ == "__main__":
    main()
