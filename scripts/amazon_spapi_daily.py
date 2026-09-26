#!/usr/bin/env python3
"""Amazon US sales per day from the Selling Partner API (Sales and Traffic report, role Brand Analytics).
Secrets via gate vault exec (AMZ_LWA_CLIENT_ID, AMZ_LWA_CLIENT_SECRET, AMZ_LWA_REFRESH_TOKEN); contract in docs/DAILY-REFRESH.md."""
import argparse, gzip, json, os, ssl, sys, time, urllib.parse, urllib.request
from datetime import date, datetime, timedelta, timezone

LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"
NA_ENDPOINT = "https://sellingpartnerapi-na.amazon.com"
US_MARKETPLACE = "ATVPDKIKX0DER"
REPORT_TYPE = "GET_SALES_AND_TRAFFIC_REPORT"
USER_AGENT = "NordicPirates-MarketingPortal/1.0 (Language=Python/3; Platform=Linux)"

def ctx():
    ca = os.environ.get("NODE_EXTRA_CA_CERTS")
    return ssl.create_default_context(cafile=ca) if ca and os.path.exists(ca) else None

def http(method, url, headers=None, body=None, timeout=60):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx()) as r:
        return r.status, r.read()

def access_token():
    form = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": os.environ["AMZ_LWA_REFRESH_TOKEN"],
        "client_id": os.environ["AMZ_LWA_CLIENT_ID"],
        "client_secret": os.environ["AMZ_LWA_CLIENT_SECRET"],
    }).encode()
    _, raw = http("POST", LWA_TOKEN_URL, {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"}, form)
    tok = json.loads(raw)
    if "access_token" not in tok:
        sys.exit(f"LWA refused the refresh token: {json.dumps(tok)[:300]}")
    return tok["access_token"]

def api(method, path, token, body=None):
    headers = {"x-amz-access-token": token, "user-agent": USER_AGENT, "content-type": "application/json",
               "x-amz-date": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(6):
        try:
            _, raw = http(method, NA_ENDPOINT + path, headers, data)
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                time.sleep(2 ** attempt * 5); continue
            sys.exit(f"SP-API {method} {path} failed: HTTP {e.code} {e.read()[:300]!r}")

def fetch_report(token, start, end):
    body = {"reportType": REPORT_TYPE, "marketplaceIds": [US_MARKETPLACE],
            "dataStartTime": f"{start}T00:00:00Z", "dataEndTime": f"{end}T23:59:59Z",
            "reportOptions": {"dateGranularity": "DAY", "asinGranularity": "PARENT"}}
    report_id = api("POST", "/reports/2021-06-30/reports", token, body)["reportId"]
    for _ in range(40):
        time.sleep(15)
        rep = api("GET", f"/reports/2021-06-30/reports/{report_id}", token)
        status = rep.get("processingStatus")
        if status == "DONE": break
        if status in ("CANCELLED", "FATAL"):
            sys.exit(f"report {report_id} ended {status}: {json.dumps(rep)[:300]}")
    else:
        sys.exit(f"report {report_id} not done after 10 minutes")
    doc = api("GET", f"/reports/2021-06-30/documents/{rep['reportDocumentId']}", token)
    _, raw = http("GET", doc["url"], {}, None, timeout=120)
    if doc.get("compressionAlgorithm") == "GZIP":
        raw = gzip.decompress(raw)
    return json.loads(raw)

def rows_from(report):
    out = []
    for d in report.get("salesAndTrafficByDate", []):
        s, t = d.get("salesByDate", {}), d.get("trafficByDate", {})
        ops = s.get("orderedProductSales", {})
        out.append({"date": d["date"], "orders": s.get("totalOrderItems"), "units": s.get("unitsOrdered"),
                    "sales_usd": round(float(ops.get("amount", 0.0)), 2), "currency": ops.get("currencyCode", "USD"),
                    "sessions": t.get("sessions"), "buy_box_pct": t.get("buyBoxPercentage"), "source": "spapi"})
    return sorted(out, key=lambda r: r["date"])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=35, help="How many days back to pull (report by DAY)")
    ap.add_argument("--out", default="amazon_spapi_daily.json")
    ap.add_argument("--check", action="store_true", help="Only exchange the refresh token, print nothing secret")
    a = ap.parse_args()
    for k in ("AMZ_LWA_CLIENT_ID", "AMZ_LWA_CLIENT_SECRET", "AMZ_LWA_REFRESH_TOKEN"):
        if not os.environ.get(k): sys.exit(f"missing {k} in the environment: run through gate vault exec")
    token = access_token()
    if a.check:
        print("LWA ok: refresh token accepted, access token received"); return
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=a.days - 1)
    rows = rows_from(fetch_report(token, start.isoformat(), end.isoformat()))
    json.dump({"source": "spapi:" + REPORT_TYPE, "marketplace": US_MARKETPLACE, "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "start": start.isoformat(), "end": end.isoformat(), "days": rows}, open(a.out, "w"), indent=1)
    print(f"{len(rows)} days {start} to {end} -> {a.out}")
    for r in rows[-3:]: print(r)

if __name__ == "__main__":
    main()
