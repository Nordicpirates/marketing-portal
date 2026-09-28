#!/usr/bin/env python3
"""Write the five periods and the yesterday block of data/snapshot.json from the raw pulls.

Inputs, run order and what each check guards: docs/DAILY-REFRESH.md.
"""

import argparse
import collections
import json
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Stockholm")
SV_MONTHS = ["", "januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti",
             "september", "oktober", "november", "december"]
EN_MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August",
             "September", "October", "November", "December"]
SHORT_NAMES = {"GB": "UK", "US": "USA"}
FRESH_CARD = "Alla siffror nyhämtade"


def kr(x):
    return f"{round(x):,}".replace(",", " ") + " kr"


def eur(x):
    return "€" + f"{round(x):,}".replace(",", " ")


def sv(x, n=2):
    return f"{x:,.{n}f}".replace(",", " ").replace(".", ",")


def sv_date(d):
    return f"{d.day} {SV_MONTHS[d.month]}"


def span(s, e):
    if s == e:
        return f"{e.day} {SV_MONTHS[e.month][:3]}"
    if (s.year, s.month) == (e.year, e.month):
        return f"{s.day}-{e.day} {SV_MONTHS[e.month][:3]}"
    return f"{s.day} {SV_MONTHS[s.month][:3]}-{e.day} {SV_MONTHS[e.month][:3]}"


def flag(code):
    if len(code) != 2 or not code.isalpha():
        return "🏳️"
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in code.upper())


def day_list(s, e):
    return [(s + timedelta(i)).isoformat() for i in range((e - s).days + 1)]


def windows(yesterday):
    return {
        "7d": (yesterday - timedelta(6), yesterday),
        "30d": (yesterday - timedelta(29), yesterday),
        "thismonth": (yesterday.replace(day=1), yesterday),
        "90d": (yesterday - timedelta(89), yesterday),
        "yesterday": (yesterday, yesterday),
    }


def meta_window(meta, totals, pid, s, e):
    want = day_list(s, e)
    if all(d in meta for d in want):
        rows = [meta[d] for d in want]
        value = sum(r["value"] if "value" in r else r["spend"] * (r["roas"] or 0) for r in rows)
        return sum(r["spend"] for r in rows), value, sum(r["purchases"] or 0 for r in rows)
    if pid in totals:
        return totals[pid]
    raise SystemExit(f"Meta: {pid} {s}..{e} is not in --meta-daily and has no --meta-total")


def shop_window(shop, since, s, e):
    if since > s.isoformat():
        raise SystemExit(f"Shopify: the pull starts {since}, after the period start {s}")
    rows = [shop[d] for d in day_list(s, e) if d in shop]
    tally = collections.defaultdict(lambda: {"name": "Unknown", "orders": 0, "revenue_eur": 0.0})
    for r in rows:
        if "by_country" not in r:
            raise SystemExit("Shopify: no by_country in the daily file, re-pull with scripts/shopify_daily.py")
        for code, c in r["by_country"].items():
            t = tally[code]
            t["name"] = c["name"]
            t["orders"] += c["orders"]
            t["revenue_eur"] += c["revenue_eur"]
    by_country = [{"name": SHORT_NAMES.get(code, c["name"]), "flag": flag(code),
                   "orders": c["orders"], "revenue": eur(c["revenue_eur"])}
                  for code, c in sorted(tally.items(), key=lambda kv: (-kv[1]["revenue_eur"], kv[0]))]
    orders = sum(r["orders"] for r in rows)
    if orders != sum(c["orders"] for c in by_country):
        raise SystemExit(f"Shopify: country split does not add up to {orders} orders for {s}..{e}")
    return orders, sum(r["revenue_eur"] for r in rows), by_country


def gads_window(rows, s, e):
    camp = collections.defaultdict(lambda: [0.0, 0.0, 0.0])
    for r in rows:
        if s.isoformat() <= r["segments"]["date"] <= e.isoformat():
            m, c = r["metrics"], camp[r["campaign"]["name"]]
            c[0] += int(m["costMicros"]) / 1e6
            c[1] += float(m.get("conversions", 0))
            c[2] += float(m.get("conversionsValue", 0))
    campaigns = [{"name": n, "spend_label": kr(c[0]), "spend_sek": round(c[0]), "conv": round(c[1]),
                  "value_label": kr(c[2]), "conv_value_sek": round(c[2]),
                  "roas": round(c[2] / c[0], 2) if c[0] else 0.0}
                 for n, c in sorted(camp.items(), key=lambda kv: -kv[1][0])]
    return (sum(c[0] for c in camp.values()), sum(c[1] for c in camp.values()),
            sum(c[2] for c in camp.values()), campaigns)


def meta_note(pid, s, e, today, hours, m, shop, gads):
    msp, mval, mpur = m
    orders, revenue, shop_sek = shop
    spend = msp + gads
    blended = shop_sek / spend if spend else None
    if pid == "yesterday":
        read = f", läst {hours} timmar efter dygnets slut" if hours is not None else ""
        claim = f" Metas anspråk är därmed {round(mval / shop_sek * 100)} procent av hela kassan." if shop_sek else ""
        real = f" Mätt mot riktiga pengar: {sv(blended)} tillbaka per annonskrona." if blended else ""
        return (f"Allt hämtat {sv_date(today)}{read}. {sv_date(e)}: Meta drog {kr(msp)} och bokför {mpur} köp "
                f"värda {kr(mval)}, alltså {sv(mval / msp) if msp else '0'} tillbaka enligt kontot. Butiken tog in "
                f"{sv(revenue)} EUR på {orders} ordrar, cirka {kr(shop_sek)} från ALLA kanaler.{claim}{real}")
    google = f"Google drog {kr(gads)} i fönstret. " if gads else "Google hade ingen spend i fönstret. "
    return (f"Meta {s} till {e}, hämtat {sv_date(today)}. {kr(mval)} tillbaka på {kr(msp)} satsat, {mpur} köp "
            f"enligt kontot. {google}Blandad avkastning = butikens hela försäljning ({kr(shop_sek)}) delad med "
            f"Meta plus Google ({kr(spend)}). Metas egen siffra är ett anspråk; den blandade bygger på riktiga "
            f"pengar och är den som ska styra beslut.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--meta-daily", required=True, help="{days:[{date,spend,roas,purchases,value}]} in SEK")
    ap.add_argument("--meta-total", action="append", default=[],
                    help="id=since:until:spend:value:purchases, for a period the daily file does not cover")
    ap.add_argument("--shopify-daily", required=True, help="output of scripts/shopify_daily.py")
    ap.add_argument("--gads", required=True, help="output of gate gads campaign-metrics")
    ap.add_argument("--gads-since", required=True)
    ap.add_argument("--gads-until", required=True)
    ap.add_argument("--today", help="YYYY-MM-DD, default today in Stockholm")
    a = ap.parse_args()

    now = datetime.now(TZ)
    today = date.fromisoformat(a.today) if a.today else now.date()
    hours = now.hour if not a.today else None
    yesterday = today - timedelta(1)
    win = windows(yesterday)

    path = f"{a.repo}/data/snapshot.json"
    snap = json.load(open(path))
    rate = re.search(r"([0-9]+(?:\.[0-9]+)?) SEK/EUR", snap.get("currency_note", ""))
    if not rate:
        raise SystemExit("currency_note carries no 'N SEK/EUR' rate")
    rate = float(rate.group(1))

    meta = {d["date"]: d for d in json.load(open(a.meta_daily))["days"]}
    totals = {}
    for spec in a.meta_total:
        pid, rest = spec.split("=", 1)
        since, until, spend, value, purchases = rest.split(":")
        if pid not in win or (since, until) != (win[pid][0].isoformat(), win[pid][1].isoformat()):
            raise SystemExit(f"--meta-total {pid} covers {since}..{until}, the period does not")
        totals[pid] = (float(spend), float(value), int(purchases))
    shop_file = json.load(open(a.shopify_daily))
    shop = {d["date"]: d for d in shop_file["days"]}
    gads_rows = json.load(open(a.gads))["data"].get("results") or []
    first = min(s for s, _ in win.values())
    if a.gads_since > first.isoformat() or a.gads_until < yesterday.isoformat():
        raise SystemExit(f"Google Ads pull {a.gads_since}..{a.gads_until} does not cover {first}..{yesterday}")
    spent_days = sorted(r["segments"]["date"] for r in gads_rows if int(r["metrics"]["costMicros"]) > 0)
    last_gads = date.fromisoformat(spent_days[-1]) if spent_days else None

    for p in snap["periods"]:
        pid = p["id"]
        if pid not in win:
            print(f"left alone: unknown period {pid}")
            continue
        s, e = win[pid]
        m = meta_window(meta, totals, pid, s, e)
        orders, revenue, by_country = shop_window(shop, shop_file["since"], s, e)
        gsp, gconv, gval, gcamps = gads_window(gads_rows, s, e)
        shop_sek = revenue * rate
        spend = m[0] + gsp

        p.update(range_start=s.isoformat(), range_end=e.isoformat(), days=(e - s).days + 1)
        if pid == "thismonth":
            p["label"] = f"{EN_MONTHS[e.month]} (month to date)"
        if pid == "yesterday":
            p["label"] = f"Yesterday ({EN_MONTHS[e.month][:3]} {e.day})"
        p.setdefault("kpis", {}).update(orders=orders, shopify_sales_eur=round(revenue, 2), sales_label=eur(revenue))
        p["orders_by_country"] = by_country
        p.setdefault("meta", {}).update(
            spend_label=kr(m[0]), spend_window=f"{span(s, e)} (Meta, hämtad {today.day} {SV_MONTHS[today.month][:3]})",
            meta_roas=round(m[1] / m[0], 2) if m[0] else 0.0,
            blended_mer=round(shop_sek / spend, 2) if spend else None,
            _note=meta_note(pid, s, e, today, hours, m, (orders, revenue, shop_sek), gsp))
        last = f" Senaste spend var {sv_date(last_gads)}." if last_gads else ""
        p.setdefault("gads", {}).update(
            spend_label=kr(gsp), gads_roas=round(gval / gsp, 2) if gsp else 0.0, conv=round(gconv),
            value_label=kr(gval), campaigns=gcamps,
            _note=f"Google Ads, nyhämtat {sv_date(today)}, "
                  + ("ingen spend i fönstret - verifierat med en egen hämtning, inte antaget." if not gsp
                     else "siffran gäller de dagar i fönstret som hade spend.") + last)
        # a dated flag describes one day, so it leaves every window that no longer holds that day
        p["flags"] = [f for f in p.get("flags", []) if not f.get("date") or s.isoformat() <= f["date"] <= e.isoformat()]

        if pid == "yesterday":
            snap["yesterday"] = {
                "date": e.isoformat(), "orders": orders, "revenue_eur": round(revenue, 2),
                "revenue_sek": round(shop_sek), "sessions": None, "conversions": orders,
                "gads_spend": None, "gads_spend_sek": round(gsp), "gads_roas": round(gval / gsp, 2) if gsp else 0.0,
                "gads_conv": round(gconv), "meta_spend_sek": round(m[0]), "_note": p["meta"]["_note"]}
            quiet = not last_gads or (yesterday - last_gads).days >= 7
            snap["gads"]["yesterday_label"] = kr(gsp) + (" (pausat)" if quiet and not gsp else "")

    snap["generated_at"] = today.isoformat()
    for k in ("shopify", "meta", "gads"):
        snap["sources"].setdefault(k, {}).update(as_of=yesterday.isoformat(), pulled=today.isoformat())
    snap["gads"]["as_of"] = f"{yesterday.day} {EN_MONTHS[yesterday.month]}"
    gp = snap.get("gads_periods")
    if gp and gp.get("since"):
        gp["until"] = yesterday.isoformat()
        gp["days"] = (yesterday - date.fromisoformat(gp["since"])).days + 1
    for card in snap.get("dashboard_status", []):
        if card.get("title", "").startswith(FRESH_CARD):
            card["title"] = f"{FRESH_CARD} {sv_date(today)}"
            card["desc"] = (f"Butik, Meta och Google Ads är lästa samma morgon och täcker till och med "
                            f"{sv_date(yesterday)}, ordrar per land inräknade. Googles nollor är verifierade "
                            f"med en egen hämtning, inte antagna.")

    open(path, "w").write(json.dumps(snap, ensure_ascii=False, indent=1))
    for p in (p for p in snap["periods"] if p["id"] in win):
        print(f"{p['id']:<10} {p['range_start']}..{p['range_end']}  orders {p['kpis']['orders']:>4}  "
              f"{p['kpis']['sales_label']:>9}  meta {p['meta']['spend_label']:>11} ({p['meta']['meta_roas']})  "
              f"blended {p['meta']['blended_mer']}  gads {p['gads']['spend_label']}  flags {len(p['flags'])}")


if __name__ == "__main__":
    main()
