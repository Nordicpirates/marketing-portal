#!/usr/bin/env python3
"""Add Amazon sales (USD -> EUR), total sales and a daily ROAS series to data/snapshot.json.
Usage and the data contract: docs/DAILY-REFRESH.md. Never invents a number: missing input = null + note."""
import argparse, json, sys, urllib.request, re, os
from datetime import date, datetime, timedelta, timezone

ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"

def ecb_rates():
    ca = os.environ.get("NODE_EXTRA_CA_CERTS")
    ctx = None
    if ca and os.path.exists(ca):
        import ssl; ctx = ssl.create_default_context(cafile=ca)
    xml = urllib.request.urlopen(ECB_URL, timeout=30, context=ctx).read().decode()
    day = re.search(r"time='(\d{4}-\d{2}-\d{2})'", xml).group(1)
    usd = float(re.search(r"currency='USD' rate='([0-9.]+)'", xml).group(1))
    sek = float(re.search(r"currency='SEK' rate='([0-9.]+)'", xml).group(1))
    return {"usd_per_eur": usd, "sek_per_eur": sek, "date": day, "source": "ECB eurofxref-daily"}

def read_amazon_xlsx(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["daily"] if "daily" in wb.sheetnames else wb.worksheets[0]
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r or r[0] in (None, ""): continue
        d = r[0]
        if isinstance(d, datetime): d = d.strftime("%Y-%m-%d")
        d = str(d).strip()[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d): continue
        orders = r[1] if len(r) > 1 and r[1] not in (None, "") else None
        usd = r[2] if len(r) > 2 and r[2] not in (None, "") else None
        if usd is None: continue
        rows.append({"date": d, "orders": int(orders) if orders is not None else None, "sales_usd": round(float(usd), 2)})
    return rows

def period_sum(days_by_date, start, end, key):
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    total, covered, n = 0.0, 0, 0
    cur = d0
    while cur <= d1:
        n += 1
        row = days_by_date.get(cur.isoformat())
        if row is not None and row.get(key) is not None:
            total += row[key]; covered += 1
        cur += timedelta(days=1)
    return total, covered, n

def eur_label(v):
    return "€" + f"{v:,.0f}".replace(",", " ") if v is not None else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--meta-daily", required=True, help="JSON with days[{date,spend,roas,purchases}] in SEK")
    ap.add_argument("--shopify-daily", required=True, help="JSON with days[{date,orders,revenue_eur}]")
    ap.add_argument("--amazon-xlsx", help="Export of the 'Amazon daily sales' sheet; merged into data/amazon-daily.json")
    ap.add_argument("--no-ecb", action="store_true", help="Keep the fx block already in the snapshot")
    a = ap.parse_args()

    snap_path = os.path.join(a.repo, "data", "snapshot.json")
    amz_path = os.path.join(a.repo, "data", "amazon-daily.json")
    snap = json.load(open(snap_path))
    meta = {d["date"]: d for d in json.load(open(a.meta_daily))["days"]}
    shop = {d["date"]: d for d in json.load(open(a.shopify_daily))["days"]}
    amz = json.load(open(amz_path)) if os.path.exists(amz_path) else {"sheet_url": None, "days": []}

    if a.amazon_xlsx:
        new = {r["date"]: r for r in read_amazon_xlsx(a.amazon_xlsx)}
        old = {r["date"]: r for r in amz.get("days", [])}
        old.update(new)
        amz["days"] = [old[k] for k in sorted(old)]
        amz["sheet_read_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    fx = snap.get("fx") if a.no_ecb else None
    if not fx:
        try: fx = ecb_rates()
        except Exception as e:
            fx = snap.get("fx") or {"usd_per_eur": None, "sek_per_eur": None, "date": None, "source": "unavailable"}
            fx["error"] = f"ECB fetch failed: {e}"
    snap["fx"] = fx
    usd_per_eur = fx.get("usd_per_eur")

    m = re.search(r"([0-9]+(?:\.[0-9]+)?) SEK/EUR", snap.get("currency_note", ""))
    sek_per_eur = float(m.group(1)) if m else fx.get("sek_per_eur")

    for r in amz["days"]:
        r["sales_eur"] = round(r["sales_usd"] / usd_per_eur, 2) if usd_per_eur and r.get("sales_usd") is not None else None
    amz_by_date = {r["date"]: r for r in amz["days"]}
    amz["as_of"] = amz["days"][-1]["date"] if amz["days"] else None
    amz["pending"] = not amz["days"]
    amz["fx_used"] = {"usd_per_eur": usd_per_eur, "date": fx.get("date"), "source": fx.get("source")}
    amz["note"] = ("Amazon US gross sales per day in USD, typed into the sheet from Seller Central > Business Reports, "
                   "converted at the ECB reference rate on the day the portal refreshed. No rows yet = no number shown; nothing is estimated.")
    snap["amazon"] = amz

    by_period = {}
    for p in snap.get("periods", []):
        k = p.setdefault("kpis", {})
        s_total, s_cov, n = period_sum(shop, p["range_start"], p["range_end"], "revenue_eur")
        # The period's own Shopify figure stays the refresh's number; the daily file only fills the split.
        shop_eur = k.get("shopify_sales_eur")
        if shop_eur is None:
            lbl = k.get("sales_label") or ""
            digits = re.sub(r"[^0-9.]", "", lbl.replace(",", ""))
            shop_eur = float(digits) if digits else (round(s_total, 2) if s_cov == n else None)
        k["shopify_sales_eur"] = shop_eur
        a_total, a_cov, _ = period_sum(amz_by_date, p["range_start"], p["range_end"], "sales_eur")
        a_usd, _, _ = period_sum(amz_by_date, p["range_start"], p["range_end"], "sales_usd")
        a_orders, _, _ = period_sum(amz_by_date, p["range_start"], p["range_end"], "orders")
        have_amz = a_cov > 0
        k["amazon_sales_eur"] = round(a_total, 2) if have_amz else None
        k["amazon_sales_usd"] = round(a_usd, 2) if have_amz else None
        k["amazon_days_covered"] = a_cov
        k["amazon_label"] = eur_label(k["amazon_sales_eur"]) if have_amz else None
        k["total_sales_eur"] = round((shop_eur or 0) + a_total, 2) if (have_amz and shop_eur is not None) else None
        k["total_label"] = eur_label(k["total_sales_eur"])
        by_period[p["id"]] = {"orders": int(a_orders) if have_amz else None, "sales_usd": k["amazon_sales_usd"],
                              "sales_eur": k["amazon_sales_eur"], "days_covered": a_cov, "days_total": n}
        mt = p.setdefault("meta", {})
        spend_digits = re.sub(r"[^0-9.]", "", (mt.get("spend_label") or "").replace(",", "").replace(" ", ""))
        meta_spend_sek = float(spend_digits) if spend_digits else None
        g = p.get("gads") or {}
        g_digits = re.sub(r"[^0-9.]", "", (g.get("spend_label") or "").replace(",", "").replace(" ", ""))
        gads_spend_sek = float(g_digits) if g_digits else 0.0
        ad_spend = (meta_spend_sek or 0) + gads_spend_sek
        if have_amz and k["total_sales_eur"] is not None and ad_spend > 0 and sek_per_eur:
            mt["blended_mer_total"] = round(k["total_sales_eur"] * sek_per_eur / ad_spend, 2)
        else:
            mt["blended_mer_total"] = None
    amz["by_period"] = by_period

    last = max(meta) if meta else None
    series = []
    if last:
        end = date.fromisoformat(last); start = end - timedelta(days=29)
        cur = start
        while cur <= end:
            k = cur.isoformat(); md = meta.get(k); sd = shop.get(k); ad = amz_by_date.get(k)
            spend = md["spend"] if md else None
            shop_eur = sd["revenue_eur"] if sd else 0.0
            amz_eur = ad.get("sales_eur") if ad else None
            shop_sek = round(shop_eur * sek_per_eur, 2) if sek_per_eur else None
            blended = round(shop_sek / spend, 2) if (spend and shop_sek is not None) else None
            blended_total = round((shop_eur + amz_eur) * sek_per_eur / spend, 2) if (spend and amz_eur is not None and sek_per_eur) else None
            series.append({"date": k, "meta_spend_sek": spend, "meta_roas": (round(md["roas"], 2) if md and md.get("roas") is not None else (0.0 if md else None)),
                           "meta_purchases": (md.get("purchases") if md else None), "shopify_orders": (sd["orders"] if sd else 0),
                           "shopify_rev_eur": round(shop_eur, 2), "amazon_rev_eur": amz_eur, "blended_mer": blended, "blended_mer_total": blended_total})
            cur += timedelta(days=1)
    snap["roas_series"] = {
        "as_of": last, "sek_per_eur": sek_per_eur,
        "note": ("Per day, Stockholm time. Meta ROAS is the account's own attributed purchase value over spend. "
                 "Blended = the store's whole Shopify revenue (all channels) over Meta spend; Google Ads has been paused since 12 Sep. "
                 f"SEK per EUR {sek_per_eur}. Amazon joins the blended figure the day the sheet has a row for that date."),
        "days": series}
    json.dump(snap, open(snap_path, "w"), ensure_ascii=False, indent=1)
    json.dump(amz, open(amz_path, "w"), ensure_ascii=False, indent=1)
    print(f"fx {fx.get('usd_per_eur')} USD/EUR ({fx.get('date')}), sek/eur {sek_per_eur}; amazon days {len(amz['days'])}; series {len(series)} days to {last}")

if __name__ == "__main__":
    main()
