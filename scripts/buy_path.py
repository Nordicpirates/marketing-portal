#!/usr/bin/env python3
"""The buy-path test, dark and light x checkout and cart, into data/snapshot.json "buy_path".

Run from the repo root through gate vault exec (Shopify credentials). Docs: docs/DAILY-REFRESH.md.

  gate vault exec --env CID=Shopify_client_ID --env SEC=SHOPIFYFULL -- \
    python3 scripts/buy_path.py [--property 250338585] [--today YYYY-MM-DD] [--dry-run]

Orders and money come from Shopify by the order's lp_arm cart attribute, visits from GA4 by
landing page. Either one unreadable means nothing is written and the old block keeps its date.
"""

import argparse
import collections
import json
import os
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lp_names  # noqa: E402
from ga_landing_pages import ga_rows  # noqa: E402

SHOP = "2b988c-3.myshopify.com"
TZ = ZoneInfo("Europe/Stockholm")
TEST_START = "2026-10-07"

# The four arms in the order the page pairs them; /lp/dark and /lp/light split 50/50 into each pair.
ARMS = [
    ("dark_checkout", "/lp/v2"),
    ("dark_cart", "/lp/v3"),
    ("light_checkout", "/lp/Q4"),
    ("light_cart", "/lp/Q4v2"),
]

NOTE = ("Orders carry the page's own tag; visits are Google Analytics sessions and miss visitors who "
        "decline cookies, so the rates are ceilings. An order without a tag is unattributed, not proof "
        "it never saw a landing page.")

ORDERS_QUERY = """query($q:String!,$after:String){ orders(first:250, after:$after, sortKey:CREATED_AT, query:$q){
  pageInfo{hasNextPage endCursor}
  nodes{ createdAt cancelledAt test customAttributes{key value}
    currentTotalPriceSet{ shopMoney{ amount currencyCode } } } } }"""


def shopify_token():
    body = json.dumps({
        "client_id": os.environ["CID"],
        "client_secret": os.environ["SEC"],
        "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request(f"https://{SHOP}/admin/oauth/access_token", data=body,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["access_token"]


def tagged_orders(token, start, end):
    """[(Stockholm day, lp_arm, EUR)] for orders start..end, test and cancelled orders left out."""
    since = (start - timedelta(days=1)).isoformat()
    out, after = [], None
    while True:
        req = urllib.request.Request(
            f"https://{SHOP}/admin/api/2025-07/graphql.json",
            data=json.dumps({"query": ORDERS_QUERY, "variables": {"q": f"created_at:>={since}", "after": after}}).encode(),
            headers={"Content-Type": "application/json", "X-Shopify-Access-Token": token})
        payload = json.loads(urllib.request.urlopen(req, timeout=120).read())
        if payload.get("errors") or not payload.get("data"):
            raise SystemExit(f"Shopify refused the orders query: {json.dumps(payload.get('errors'))[:400]}")
        data = payload["data"]["orders"]
        for o in data["nodes"]:
            day = datetime.fromisoformat(o["createdAt"].replace("Z", "+00:00")).astimezone(TZ).date()
            if o["test"] or o["cancelledAt"] or not (start <= day <= end):
                continue
            arms = {a["value"] for a in o["customAttributes"] if a["key"] == "lp_arm" and a["value"]}
            if not arms:
                continue
            if len(arms) > 1:
                raise SystemExit(f"an order on {day} carries two lp_arm values {sorted(arms)}; nothing written")
            money = o["currentTotalPriceSet"]["shopMoney"]
            if money["currencyCode"] != "EUR":
                raise SystemExit(f"an order on {day} is in {money['currencyCode']}, the block is in EUR; nothing written")
            out.append((day.isoformat(), arms.pop(), Decimal(money["amount"])))
        if not data["pageInfo"]["hasNextPage"]:
            break
        after = data["pageInfo"]["endCursor"]
        time.sleep(0.3)
    return out


def ga_sessions(prop, names, start, end):
    """{canonical path: [sessions, purchases]}; ga_rows refuses a report GA4 cut short."""
    return lp_names.merge(names, ga_rows(prop, start, end))


def ratio(top, sessions):
    return round(top / sessions * 100, 2) if sessions else None


def window_block(names, start, end, orders, ga):
    """One window: the four arms with visits, and every other tag with orders and money only."""
    by_arm = collections.defaultdict(lambda: [0, Decimal("0")])
    for day, arm, eur in orders:
        if start <= day <= end:
            by_arm[arm][0] += 1
            by_arm[arm][1] += eur
    # By key, not spelling: an arm missing from the names file is keyed by GA's busiest spelling.
    visits = {lp_names.key_of(p): v for p, v in ga.items()}
    arms = []
    for arm, path in ARMS:
        sessions, purchases = visits.get(lp_names.key_of(path), [0, 0])
        count, eur = by_arm.get(arm, [0, Decimal("0")])
        revenue = float(round(eur, 2))
        arms.append({
            "arm": arm, "name": lp_names.name_for(names, path), "path": path,
            "sessions": sessions, "ga_purchases": purchases, "orders": count, "revenue_eur": revenue,
            "conv_pct": ratio(count, sessions), "eur_per_100": ratio(revenue, sessions),
        })
    known = {a for a, _ in ARMS}
    campaign = [{"arm": arm, "orders": n, "revenue_eur": float(round(eur, 2))}
                for arm, (n, eur) in sorted(by_arm.items(), key=lambda kv: -kv[1][1]) if arm not in known]
    return {"start": start, "end": end, "arms": arms, "campaign": campaign}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--property", default="250338585")
    ap.add_argument("--today", help="YYYY-MM-DD, default today in Stockholm")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    today = date.fromisoformat(args.today) if args.today else datetime.now(TZ).date()
    yesterday = today - timedelta(days=1)
    windows = {"test": (TEST_START, yesterday.isoformat()),
               "7d": ((yesterday - timedelta(days=6)).isoformat(), yesterday.isoformat())}
    first = min(date.fromisoformat(s) for s, _ in windows.values())

    path = f"{args.repo}/data/snapshot.json"
    snap = json.load(open(path), object_pairs_hook=collections.OrderedDict)
    names = lp_names.load(args.repo)

    orders = tagged_orders(shopify_token(), first, yesterday)
    block = {"windows": {}, "note": NOTE}
    for key, (start, end) in windows.items():
        w = window_block(names, start, end, orders, ga_sessions(args.property, names, start, end))
        block["windows"][key] = w
        print(f"\n{key} {start}..{end}")
        for a in w["arms"]:
            print(f"  {a['name']:<15} {a['path']:<9} sessions {a['sessions']:>5}  orders {a['orders']:>3}  "
                  f"EUR {a['revenue_eur']:>8.2f}  conv {a['conv_pct']}%  EUR/100 {a['eur_per_100']}  GA purchases {a['ga_purchases']}")
        for c in w["campaign"]:
            print(f"  {c['arm']:<25} orders {c['orders']:>3}  EUR {c['revenue_eur']:>8.2f}")

    snap["buy_path"] = block
    snap["sources"]["buy_path"] = {
        "as_of": yesterday.isoformat(), "pulled": today.isoformat(),
        "note": f"Shopify orders by lp_arm, GA4 property {args.property} sessions by landing page"}

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    # A failed write must not leave half a snapshot: the old file stays until the new one is whole.
    tmp = path + ".tmp"
    with open(tmp, "w") as handle:
        handle.write(json.dumps(snap, ensure_ascii=False, indent=1))
    os.replace(tmp, path)
    print(f"\nwritten: {path}, sources.buy_path as_of {yesterday}")


if __name__ == "__main__":
    main()
