#!/usr/bin/env python3
"""Stock, channels, the 14-day sessions chart and the 10-day orders chart, into data/snapshot.json.

Run from the repo root after the periods are written. Docs: docs/DAILY-REFRESH.md.

  gate vault exec --env CID=Shopify_client_ID --env SEC=SHOPIFYFULL -- \
    python3 scripts/daily_sections.py --shopify-daily shopify.json [--property 250338585] [--dry-run]

Stock is Shopify's "available" per variant and warehouse, never "on hand". Velocity is units
sold per day over the last 30 closed Stockholm days, cancelled orders skipped.
"""

import argparse
import collections
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

SHOP = "2b988c-3.myshopify.com"
API = f"https://{SHOP}/admin/api/2025-07/graphql.json"
TZ = ZoneInfo("Europe/Stockholm")

# The sellable warehouses the stock page shows. The showroom is the office, not stock.
WAREHOUSES = [
    ("bridge", "Bridge (USA)", "Bridge - Georgia USA"),
    ("armarlo", "Armarlo (AU)", "Armarlo Distribution"),
    ("meeples", "Meeples (EU)", "Meeples Distribution"),
    ("zatu", "Zatu (UK)", "Zatu Games"),
]
ALL = [w[0] for w in WAREHOUSES]

# The assortment Lucas follows (Add-On Box and Upgrade Box left out on his word, 24 Jul 2026).
CATALOGUE = [
    ("NPGLPGFBB01EN", "BIG BOX", "English", ALL),
    ("NPGLPGFBB01IT", "BIG BOX", "Italian", ["meeples"]),
    ("NPGLPGFBB01DE", "BIG BOX", "German", ["meeples"]),
    ("NPGLPGFBB01FR", "BIG BOX", "French", ["meeples"]),
    ("NPGLPGFBB01ES", "BIG BOX", "Spanish", ["meeples"]),
    ("NPGLPGFRT02EN", "Base Game", "English", ALL),
    ("NPGLPGFRT02IT", "Base Game", "Italian", ["meeples"]),
    ("NPGLPGFRT01DE", "Base Game", "German", ["meeples"]),
    ("NPGLPGFRT01FR", "Base Game", "French", ["meeples"]),
    ("NPGLPGFRT01ES", "Base Game", "Spanish", ["meeples"]),
    ("NPGKMP01", "Kraken Mini-Expansion", "Default", ALL),
    ("NPGLPGFCOG01", "Cities of Greed", "Default", ALL),
    ("NPGCI", "Custom Insert", "Default", ALL),
    ("NPG8PCP01", "8-Player Components", "Default", ALL),
]
THRESHOLDS = {"critical": 14, "low": 30, "watch": 60}
# Base Game English and Italian moved to the V2 numbers on 28 Oct 2026; older orders still carry V1
SOLD_AS = {"NPGLPGFRT01EN": "NPGLPGFRT02EN", "NPGLPGFRT01IT": "NPGLPGFRT02IT"}

# GA4's channel names as the dashboard shows them, with the dot colour per channel.
CHANNELS = {
    "Paid Social": ("Betald social (Meta)", "#4a90e2"),
    "Organic Social": ("Organisk social", "#14b8a6"),
    "Direct": ("Direkt", "#8b5cf6"),
    "Organic Search": ("Organisk sökning", "#2f8f4e"),
    "Paid Search": ("Betald sökning (Google Ads)", "#ea4335"),
    "Unassigned": ("Okänd", "#8a8073"),
    "Email": ("E-post", "#c96a3d"),
    "Referral": ("Hänvisning", "#cf9a2e"),
}
TOP_CHANNELS = 7


def shopify_token():
    body = urllib.parse.urlencode({"client_id": os.environ["CID"], "client_secret": os.environ["SEC"],
                                   "grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(f"https://{SHOP}/admin/oauth/access_token", data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["access_token"]


def gql(token, query, variables=None):
    req = urllib.request.Request(API, data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 headers={"Content-Type": "application/json", "X-Shopify-Access-Token": token})
    payload = json.loads(urllib.request.urlopen(req, timeout=120).read())
    if payload.get("errors"):
        raise SystemExit(f"Shopify refused: {json.dumps(payload['errors'])[:400]}")
    return payload["data"]


def stock_by_sku(token):
    """{sku: {warehouse_id: available}} for every variant in the catalogue."""
    query = """query($q:String!,$after:String){ productVariants(first:50, query:$q, after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{ sku inventoryItem{ inventoryLevels(first:20){ nodes{ location{name}
        quantities(names:["available"]){quantity} } } } } } }"""
    by_location = {w[2]: w[0] for w in WAREHOUSES}
    wanted = [c[0] for c in CATALOGUE]
    found, after = {}, None
    while True:
        q = " OR ".join(f"sku:{s}" for s in wanted)
        data = gql(token, query, {"q": q, "after": after})["productVariants"]
        for v in data["nodes"]:
            if v["sku"] not in wanted:
                continue
            # one SKU can sit on two products (regular and pre-order), so their stock adds up
            row = found.setdefault(v["sku"], {w: 0 for w in ALL})
            for lv in v["inventoryItem"]["inventoryLevels"]["nodes"]:
                wid = by_location.get(lv["location"]["name"])
                if wid:
                    row[wid] += int(lv["quantities"][0]["quantity"])
        if not data["pageInfo"]["hasNextPage"]:
            break
        after = data["pageInfo"]["endCursor"]
    missing = [s for s in wanted if s not in found]
    if missing:
        raise SystemExit(f"Shopify has no variant for SKU {', '.join(missing)}: the catalogue is out of date")
    return found


def units_sold(token, start, end):
    """{sku: units} on orders created start..end (Stockholm days), cancelled orders skipped."""
    query = """query($q:String!,$after:String){ orders(first:100, query:$q, sortKey:CREATED_AT, after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{ createdAt cancelledAt lineItems(first:50){ nodes{ sku currentQuantity } } } } }"""
    since = (start - timedelta(days=1)).isoformat()
    units, after = collections.Counter(), None
    while True:
        data = gql(token, query, {"q": f"created_at:>={since}", "after": after})["orders"]
        for o in data["nodes"]:
            day = datetime.fromisoformat(o["createdAt"].replace("Z", "+00:00")).astimezone(TZ).date()
            if o["cancelledAt"] or not (start <= day <= end):
                continue
            for li in o["lineItems"]["nodes"]:
                if li["sku"]:
                    units[SOLD_AS.get(li["sku"], li["sku"])] += int(li["currentQuantity"])
        if not data["pageInfo"]["hasNextPage"]:
            break
        after = data["pageInfo"]["endCursor"]
        time.sleep(0.3)
    return units


def status_for(days):
    for name in ("critical", "low", "watch"):
        if days < THRESHOLDS[name]:
            return name
    return "ok"


def inventory_section(old, stock, units, window, today):
    products = []
    for sku, title, variant, scope in CATALOGUE:
        row = dict(stock[sku])
        row["total"] = sum(row[w] for w in ALL)
        velocity = round(units.get(sku, 0) / window, 2)
        if row["total"] <= 0:
            days = 0
        elif velocity <= 0:
            days = 999
        else:
            days = round(row["total"] / velocity)
        products.append({"title": title, "variant": variant, "sku": sku, "velocity": velocity, "stock": row,
                         "days": days, "status": status_for(days), "warehouse_scope": scope})
    return {
        "updated_at": today,
        "velocity_window_days": window,
        "filter_note": (old or {}).get("filter_note") or "Add-On Box + Upgrade Box exkluderade per Lucas 2026-07-24",
        "warehouses": [{"id": w[0], "label": w[1]} for w in WAREHOUSES],
        "thresholds": THRESHOLDS,
        "products": products,
    }


def ga(prop, metrics, dimension, start, end, limit=100):
    out = subprocess.run(["gate", "ga", "report", "--property", prop, "--metrics", metrics, "--dimensions",
                          dimension, "--start", start, "--end", end, "--limit", str(limit)],
                         capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        raise SystemExit(f"gate ga report failed for {dimension} {start}..{end}: {out.stderr.strip()[:300]}")
    payload = json.loads(out.stdout)
    if not payload.get("ok"):
        raise SystemExit(f"gate ga report answered not-ok for {dimension} {start}..{end}")
    return payload["data"]


def channels_section(prop, start, end):
    data = ga(prop, "sessions,ecommercePurchases,purchaseRevenue", "sessionDefaultChannelGroup", start, end)
    currency = (data.get("metadata") or {}).get("currencyCode")
    if currency != "SEK":
        raise SystemExit(f"GA4 reports revenue in {currency}, the channel table is in SEK")
    rows = []
    for r in data.get("rows", []):
        m = r["metricValues"]
        rows.append([r["dimensionValues"][0]["value"], int(m[0]["value"]), int(m[1]["value"]), float(m[2]["value"])])
    rows.sort(key=lambda r: -r[1])
    head, tail = rows[:TOP_CHANNELS], rows[TOP_CHANNELS:]
    if tail:
        head.append(["Övrigt", sum(r[1] for r in tail), sum(r[2] for r in tail), sum(r[3] for r in tail)])
    sessions = sum(r[1] for r in rows)
    overall = sum(r[2] for r in rows) / sessions * 100 if sessions else 0
    out = []
    for name, s, conv, rev in head:
        label, dot = CHANNELS.get(name, (name, "#8a8073"))
        cvr = round(conv / s * 100, 2) if s else None
        out.append({"name": label, "dot": dot, "sessions": s, "conversions": conv, "cvr": cvr,
                    "cvr_good": bool(cvr and cvr >= overall), "revenue_sek": round(rev), "source": "ga4"})
    return out, sum(r[2] for r in rows)


def sessions_chart(prop, start, end):
    data = ga(prop, "sessions,ecommercePurchases", "date", start, end)
    by_day = {r["dimensionValues"][0]["value"]: r["metricValues"] for r in data.get("rows", [])}
    labels, sessions, conversions = [], [], []
    day = start_d = date.fromisoformat(start)
    while day <= date.fromisoformat(end):
        m = by_day.get(day.strftime("%Y%m%d"))
        labels.append(f"{day.day}/{day.month}")
        sessions.append(int(m[0]["value"]) if m else 0)
        conversions.append(int(m[1]["value"]) if m else 0)
        day += timedelta(days=1)
    if not any(sessions):
        raise SystemExit(f"GA4 returned no sessions at all for {start_d}..{end}")
    return {"labels": labels, "sessions": sessions, "conversions": conversions}


def orders_chart(shopify_daily, start, end):
    days = {d["date"]: d for d in json.load(open(shopify_daily))["days"]}
    labels, revenue, orders = [], [], []
    day = start
    while day <= end:
        d = days.get(day.isoformat(), {})
        labels.append(f"{day.day}/{day.month}")
        revenue.append(round(d.get("revenue_eur", 0)))
        orders.append(d.get("orders", 0))
        day += timedelta(days=1)
    return {"labels": labels, "revenue": revenue, "orders": orders}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--shopify-daily", required=True, help="output of scripts/shopify_daily.py")
    ap.add_argument("--property", default="250338585")
    ap.add_argument("--today", help="YYYY-MM-DD, default today in Stockholm")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-ga", action="store_true", help="GA4 not delegated: write stock and orders, keep channels and visits")
    args = ap.parse_args()

    today = date.fromisoformat(args.today) if args.today else datetime.now(TZ).date()
    yesterday = today - timedelta(days=1)
    path = f"{args.repo}/data/snapshot.json"
    snap = json.load(open(path), object_pairs_hook=collections.OrderedDict)

    token = shopify_token()
    window = 30
    stock = stock_by_sku(token)
    units = units_sold(token, yesterday - timedelta(days=window - 1), yesterday)
    snap["inventory_data"] = inventory_section(snap.get("inventory_data"), stock, units, window, today.isoformat())
    for p in snap["inventory_data"]["products"]:
        print(f"  {p['title']:<22} {p['variant']:<8} total {p['stock']['total']:>5}  {p['velocity']:>5}/day  "
              f"{p['days']:>4} days  {p['status']}")

    c_start, c_end = (yesterday - timedelta(days=29)).isoformat(), yesterday.isoformat()
    s_start = (yesterday - timedelta(days=13)).isoformat()
    if not args.no_ga:
        snap["channels_30d"], ga_purchases = channels_section(args.property, c_start, c_end)
        print(f"channels {c_start}..{c_end}: {len(snap['channels_30d'])} rows, {ga_purchases} GA4 purchases")
        snap.setdefault("chart_data", {})["organic_14d"] = sessions_chart(args.property, s_start, c_end)
    snap.setdefault("chart_data", {})["orders_9d"] = orders_chart(args.shopify_daily, yesterday - timedelta(days=9), yesterday)
    print(f"orders chart {yesterday - timedelta(days=9)}..{c_end}" + ("; --no-ga: channels and visits kept" if args.no_ga else ""))

    pulled = today.isoformat()
    sources = snap["sources"]
    sources["inventory"] = {"as_of": pulled, "pulled": pulled}
    if not args.no_ga:
        sources["channels"] = {"as_of": c_end, "pulled": pulled,
                               "note": f"GA4 by channel {c_start} to {c_end}; GA4 sees fewer purchases than Shopify"}
        sources["sessions_chart"] = {"as_of": c_end, "pulled": pulled}

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    open(path, "w").write(json.dumps(snap, ensure_ascii=False, indent=1))
    print(f"\nwritten: {path}")


if __name__ == "__main__":
    main()
