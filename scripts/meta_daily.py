#!/usr/bin/env python3
# Meta spend per day for the portal: gate metaads first, the vault key GATE_META_APP as fallback.
# Output shape and run order: docs/DAILY-REFRESH.md.
import argparse, datetime as dt, json, os, subprocess, sys, urllib.parse, urllib.request

ACCOUNT = "act_314601282522803"
FIELDS = "spend,actions,action_values,purchase_roas"
GRAPH = "https://graph.facebook.com/v21.0/"


def pick(rows, key, name="omni_purchase"):
    for a in rows or []:
        if a.get("action_type") == name:
            return float(a.get("value") or 0)
    return 0.0


def row_to_day(r, date):
    spend = float(r.get("spend") or 0)
    value = pick(r.get("action_values"), "value")
    roas = pick(r.get("purchase_roas"), "roas") or (value / spend if spend else 0.0)
    return {"date": date, "spend": round(spend, 2), "roas": round(roas, 4),
            "purchases": int(pick(r.get("actions"), "purchases")), "value": round(value, 2)}


def gate_rows(account, since, until):
    out = subprocess.run(["gate", "metaads", "insights", "--object-id", account, "--since", since,
                          "--until", until, "--fields", FIELDS], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip() or "gate metaads failed")
    data = json.loads(out.stdout)
    if not data.get("ok"):
        raise RuntimeError(json.dumps(data)[:300])
    return data["data"].get("data", [])


def graph_rows(account, since, until, increment):
    params = {"fields": FIELDS, "time_range": json.dumps({"since": since, "until": until}), "limit": 500}
    if increment:
        params["time_increment"] = 1
    req = urllib.request.Request(GRAPH + account + "/insights?" + urllib.parse.urlencode(params),
                                 headers={"Authorization": "Bearer " + os.environ["T"].strip()})
    return json.loads(urllib.request.urlopen(req, timeout=120).read()).get("data", [])


def days_between(since, until):
    d, end = dt.date.fromisoformat(since), dt.date.fromisoformat(until)
    while d <= end:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def pull(source, account, since, until):
    if source == "gate":
        days = []
        for day in days_between(since, until):
            rows = gate_rows(account, day, day)
            days.append(row_to_day(rows[0], day) if rows else {"date": day, "spend": 0.0, "roas": 0.0, "purchases": 0, "value": 0.0})
        total = gate_rows(account, since, until)
    else:
        by_date = {r["date_start"]: r for r in graph_rows(account, since, until, True)}
        days = [row_to_day(by_date[d], d) if d in by_date else {"date": d, "spend": 0.0, "roas": 0.0, "purchases": 0, "value": 0.0}
                for d in days_between(since, until)]
        total = graph_rows(account, since, until, False)
    return days, (row_to_day(total[0], since) if total else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True)
    ap.add_argument("--until", required=True)
    ap.add_argument("--out", required=True, help="meta.json for --meta-daily")
    ap.add_argument("--total-since", help="start of the 90-day window; prints the --meta-total spec")
    ap.add_argument("--source", choices=["auto", "gate", "graph"], default="auto")
    ap.add_argument("--account", default=ACCOUNT)
    a = ap.parse_args()
    source = a.source
    if source == "auto":
        try:
            subprocess.run(["gate", "metaads", "accounts"], capture_output=True, text=True, timeout=60, check=True)
            source = "gate"
        except Exception:
            source = "graph"
    if source == "graph" and "T" not in os.environ:
        cmd = ["gate", "vault", "exec", "--env", "T=GATE_META_APP", "--", sys.executable, "-I", os.path.abspath(__file__),
               "--since", a.since, "--until", a.until, "--out", a.out, "--source", "graph", "--account", a.account]
        if a.total_since:
            cmd += ["--total-since", a.total_since]
        sys.exit(subprocess.run(cmd).returncode)
    days, total = pull(source, a.account, a.since, a.until)
    summed = round(sum(d["spend"] for d in days), 2)
    if total and abs(summed - total["spend"]) > max(5.0, 0.01 * total["spend"]):
        sys.exit(f"daily sum {summed} differs from the account total {total['spend']} for {a.since}..{a.until}")
    json.dump({"account": a.account, "source": source, "pulled": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
               "since": a.since, "until": a.until, "days": days}, open(a.out, "w"), indent=1)
    print(f"meta {source}: {len(days)} days {a.since}..{a.until}, spend {summed}, account total {total['spend'] if total else 'n/a'} -> {a.out}")
    if a.total_since:
        rows = gate_rows(a.account, a.total_since, a.until) if source == "gate" else graph_rows(a.account, a.total_since, a.until, False)
        t_total = row_to_day(rows[0], a.total_since) if rows else None
        if not t_total:
            sys.exit("no account total for the --total-since window")
        print(f"--meta-total 90d={a.total_since}:{a.until}:{t_total['spend']}:{t_total['value']}:{t_total['purchases']}")


if __name__ == "__main__":
    main()
