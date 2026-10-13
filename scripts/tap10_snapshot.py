#!/usr/bin/env python3
"""TAP 10 counts per Stockholm day for the portal's /tap10 tab, written to data/tap10.json.
How to run it, what each number means and when it refuses: docs/TAP10.md."""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

STOCKHOLM = ZoneInfo("Europe/Stockholm")
LAUNCH = "2026-10-06"
WAITLIST_LIST_ID = 10
GA_PROPERTY = "542188652"
KS_HOST = "www.kickstarter.com"
TAP10_HOSTS = {"tap10game.com", "www.tap10game.com"}
FILM_TITLE = "TAP 10 film"
REEL_PREFIX = "Reel "
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# The property also holds the Kickstarter page, so hostName is always the last dimension and
# only TAP10_HOSTS count as tap10game.com. Order of dimensions matters below.
GA_REPORTS = {
    "daily": ("date,hostName", "sessions,totalUsers,averageSessionDuration"),
    "events": ("date,eventName,hostName", "eventCount"),
    "videos": ("date,eventName,videoTitle,hostName", "eventCount"),
    "sources": ("sessionSource,sessionMedium,hostName", "sessions"),
}

DAY_FIELDS = ["signups", "waitlist_total", "waitlist_blacklisted", "ks_followers", "ks_pageviews",
              "ks_ga_sessions", "ga_sessions", "ga_users", "avg_session_sec", "ad_spend_sek", "ad_clicks",
              "film_starts", "film_completes", "reel_starts", "reel_completes",
              "demo_starts", "demo_completes", "demo_star_clicks"]


class Refused(Exception):
    """The builder will not write: the inputs disagree with themselves or with the contract."""


def days_between(since, until):
    d, end = date.fromisoformat(since), date.fromisoformat(until)
    out = []
    while d <= end:
        out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def stockholm_day(stamp):
    """ISO time with any offset (Z, +02:00, -0700) to its Stockholm calendar day."""
    s = stamp.strip().replace("Z", "+00:00")
    s = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", s)
    t = datetime.fromisoformat(s)
    if t.tzinfo is None:
        raise Refused(f"time {stamp!r} has no UTC offset, so its Stockholm day is unknown")
    return t.astimezone(STOCKHOLM).date().isoformat()


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# Brevo

def brevo_contacts(folder):
    """Every contact on every page in the folder, once each by id."""
    files = sorted(n for n in os.listdir(folder) if n.endswith(".json"))
    if not files:
        raise Refused(f"{folder} holds no Brevo contact pages (*.json)")
    seen = {}
    for name in files:
        page = load_json(os.path.join(folder, name))
        contacts = (page.get("data") or {}).get("contacts") if "data" in page else page.get("contacts")
        if not isinstance(contacts, list):
            raise Refused(f"{name} has no contacts list in data.contacts or contacts")
        for c in contacts:
            seen[c.get("id", json.dumps(c, sort_keys=True))] = c
    return list(seen.values())


def signup_day(c):
    attr = (c.get("attributes") or {}).get("SIGNUP_DATE")
    if isinstance(attr, str) and DAY_RE.match(attr.strip()):
        return attr.strip()
    if c.get("createdAt"):
        return stockholm_day(c["createdAt"])
    raise Refused(f"Brevo contact {c.get('id')} has neither SIGNUP_DATE nor createdAt, so its day is unknown")


def label(value):
    v = str(value or "").strip()
    return v or "-"


def brevo_counts(contacts, days):
    waitlist = [c for c in contacts if WAITLIST_LIST_ID in (c.get("listIds") or [])]
    first, last = days[0], days[-1]
    per_day = {d: {"signups": 0, "waitlist_total": 0, "waitlist_blacklisted": 0} for d in days}
    forms, media = {}, {}
    for c in waitlist:
        day = signup_day(c)
        blacklisted = bool(c.get("emailBlacklisted"))
        for d in days:
            if day <= d:
                per_day[d]["waitlist_blacklisted" if blacklisted else "waitlist_total"] += 1
        if first <= day <= last:
            per_day[day]["signups"] += 1
            attrs = c.get("attributes") or {}
            f, m = label(attrs.get("SIGNUP_FORM")), label(attrs.get("UTM_MEDIUM"))
            forms[f] = forms.get(f, 0) + 1
            media[m] = media.get(m, 0) + 1
    by_form = [{"form": k, "count": v} for k, v in sorted(forms.items(), key=lambda kv: (-kv[1], kv[0]))]
    by_medium = [{"medium": k, "count": v} for k, v in sorted(media.items(), key=lambda kv: (-kv[1], kv[0]))]
    return per_day, by_form, by_medium


# GA

def ga_call(prop, dims, metrics, start, end, limit):
    out = subprocess.run(
        ["gate", "ga", "report", "--property", prop, "--metrics", metrics, "--dimensions", dims,
         "--start", start, "--end", end, "--limit", str(limit)],
        capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        raise Refused(f"gate ga report {dims} failed: {out.stderr.strip()[:400]}")
    payload = json.loads(out.stdout)
    if not payload.get("ok"):
        raise Refused(f"gate ga report {dims} answered not-ok: {json.dumps(payload)[:400]}")
    return payload


def ga_rows(name, payload):
    """Rows of one report, refused when GA says it holds more than it returned."""
    data = payload.get("data") or {}
    rows = data.get("rows") or []
    count = data.get("rowCount")
    if count is None and rows:
        raise Refused(f"GA report {name} has rows but no rowCount, so truncation cannot be ruled out")
    if count is not None and int(count) != len(rows):
        raise Refused(f"GA report {name} holds {count} rows but returned {len(rows)}: truncated, raise the limit")
    return [([v["value"] for v in r["dimensionValues"]], [v["value"] for v in r["metricValues"]]) for r in rows]


def ga_pull(prop, start, end):
    """All four reports; a truncated one is asked again once with GA's own row count as the limit."""
    out = {"property": prop, "start": start, "end": end}
    for name, (dims, metrics) in GA_REPORTS.items():
        payload = ga_call(prop, dims, metrics, start, end, 10000)
        count = (payload.get("data") or {}).get("rowCount")
        if count is not None and int(count) > len((payload["data"].get("rows") or [])):
            payload = ga_call(prop, dims, metrics, start, end, int(count))
        ga_rows(name, payload)
        out[name] = payload
    return out


def ga_day(value):
    v = value.strip()
    if not re.match(r"^\d{8}$", v):
        raise Refused(f"GA date {value!r} is not YYYYMMDD")
    return f"{v[:4]}-{v[4:6]}-{v[6:]}"


def ga_counts(ga, days):
    for key in ("start", "end", *GA_REPORTS):
        if key not in ga:
            raise Refused(f"the GA file has no {key!r}")
    covered = [d for d in days if ga["start"] <= d <= ga["end"]]
    per_day = {d: {"ga_sessions": 0, "ga_users": 0, "avg_session_sec": None, "ks_ga_sessions": 0, "film_starts": 0,
                   "film_completes": 0, "reel_starts": 0, "reel_completes": 0, "demo_starts": 0,
                   "demo_completes": 0, "demo_star_clicks": 0} for d in covered}
    seconds = {}
    for (d, host), (sessions, users, avg) in ga_rows("daily", ga["daily"]):
        day = ga_day(d)
        if day not in per_day:
            continue
        if host == KS_HOST:
            per_day[day]["ks_ga_sessions"] += int(sessions)
        elif host in TAP10_HOSTS:
            per_day[day]["ga_sessions"] += int(sessions)
            per_day[day]["ga_users"] += int(users)
            seconds[day] = seconds.get(day, 0.0) + float(avg) * int(sessions)
    for day, total in seconds.items():
        if per_day[day]["ga_sessions"]:
            per_day[day]["avg_session_sec"] = round(total / per_day[day]["ga_sessions"])
    events = {"demo_start": "demo_starts", "demo_complete": "demo_completes", "try_demo_click": "demo_star_clicks"}
    for (d, name, host), (count,) in ga_rows("events", ga["events"]):
        day = ga_day(d)
        if day in per_day and name in events and host in TAP10_HOSTS:
            per_day[day][events[name]] += int(count)
    titles = {}
    for (d, name, title, host), (count,) in ga_rows("videos", ga["videos"]):
        day, n = ga_day(d), int(count)
        if day not in per_day or name not in ("video_start", "video_complete") or host not in TAP10_HOSTS:
            continue
        kind = "film" if title == FILM_TITLE else "reel" if title.startswith(REEL_PREFIX) else None
        if kind:
            per_day[day][f"{kind}_{'starts' if name == 'video_start' else 'completes'}"] += n
        t = titles.setdefault(title, {"title": title, "starts": 0, "completes": 0})
        t["starts" if name == "video_start" else "completes"] += n
    videos = sorted(titles.values(), key=lambda v: (v["title"] != FILM_TITLE, -v["starts"], v["title"]))
    merged = {}
    for (s, m, host), (n,) in ga_rows("sources", ga["sources"]):
        if host in TAP10_HOSTS:
            merged[(s, m)] = merged.get((s, m), 0) + int(n)
    sources = [{"source": s, "medium": m, "sessions": n} for (s, m), n in merged.items()]
    sources.sort(key=lambda r: (-r["sessions"], r["source"], r["medium"]))
    return per_day, videos, sources, (covered[-1] if covered else None)


# Ads, Kickstarter followers, Kickstarter page views

def ads_counts(files):
    rows = {}
    for path in files:
        data = load_json(path)
        if not isinstance(data, list):
            raise Refused(f"{path} is not a list of {{date, spend_sek, link_clicks}}")
        for r in data:
            d = r.get("date")
            if not isinstance(d, str) or not DAY_RE.match(d):
                raise Refused(f"{path} has a row without a YYYY-MM-DD date: {r}")
            row = {"ad_spend_sek": round(float(r["spend_sek"]), 2), "ad_clicks": int(r["link_clicks"])}
            if d in rows and rows[d] != row:
                raise Refused(f"two ads files disagree about {d}: {rows[d]} and {row}")
            rows[d] = row
    span = sorted(rows)
    if span:
        gaps = [d for d in days_between(span[0], span[-1]) if d not in rows]
        if gaps:
            raise Refused(f"the ads rows skip {', '.join(gaps)}: a missing day would read as no spend")
    return rows


def ks_followers(path):
    """The last reading of each Stockholm day."""
    last = {}
    with open(path, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            stamp, value = (r.get("stockholm_time") or "").strip(), (r.get("ks_followers") or "").strip()
            if not stamp or not value:
                continue
            day = stamp[:10]
            if not DAY_RE.match(day):
                raise Refused(f"{path}: {stamp!r} is not a Stockholm time")
            if day not in last or stamp >= last[day][0]:
                last[day] = (stamp, int(value))
    return {d: v for d, (_, v) in last.items()}


def ks_pageviews(files):
    """Meta dataset stats, hourly, summed into Stockholm days. Returns (per day, last covered day)."""
    buckets = {}
    for path in files:
        for b in load_json(path).get("stats") or []:
            stamp = b["timestamp"]
            count = sum(int(x.get("count") or 0) for x in b.get("data") or [] if x.get("value") == KS_HOST)
            if stamp in buckets and buckets[stamp] != count:
                raise Refused(f"two page view files disagree about the hour {stamp}: {buckets[stamp]} and {count}")
            buckets[stamp] = count
    if not buckets:
        return {}, None
    per_day = {}
    for stamp, count in buckets.items():
        day = stockholm_day(stamp)
        per_day[day] = per_day.get(day, 0) + count
    span = sorted(per_day)
    return {d: per_day.get(d, 0) for d in days_between(span[0], span[-1])}, span[-1]


# Assembly

def unavailable(why):
    return {"as_of": None, "text": "unavailable", "note": why}


def check_counts(out):
    for row in out["days"]:
        for k in DAY_FIELDS:
            if row.get(k) is not None and row[k] < 0:
                raise Refused(f"{row['date']} has a negative {k}: {row[k]}")
    for key in ("videos", "signups_by_form", "signups_by_medium", "ga_sources"):
        for r in out[key]:
            for k, v in r.items():
                if isinstance(v, (int, float)) and v < 0:
                    raise Refused(f"{key} has a negative {k}: {r}")
    dates = [r["date"] for r in out["days"]]
    if dates != days_between(dates[0], dates[-1]):
        raise Refused("the days are not contiguous")


def build(a):
    today = a.today
    days = days_between(a.since, a.until)
    rows = {d: {"date": d, **{k: None for k in DAY_FIELDS}} for d in days}
    sources = {}
    out = {"generated_at": today, "launch_date": LAUNCH, "sources": sources, "days": [],
           "videos": [], "signups_by_form": [], "signups_by_medium": [], "ga_sources": []}

    if a.brevo_contacts:
        per_day, out["signups_by_form"], out["signups_by_medium"] = brevo_counts(brevo_contacts(a.brevo_contacts), days)
        for d, v in per_day.items():
            rows[d].update(v)
        sources["signups"] = {"as_of": min(today, a.until), "pulled": today}
    else:
        sources["signups"] = unavailable("no Brevo contact pages were given")

    ga = None
    if a.ga_pull:
        ga = ga_pull(a.ga_property, a.since, a.until)
        with open(a.ga_pull, "w", encoding="utf-8") as f:
            json.dump(ga, f, indent=1)
    elif a.ga:
        ga = load_json(a.ga)
    if ga:
        per_day, out["videos"], out["ga_sources"], last = ga_counts(ga, days)
        for d, v in per_day.items():
            rows[d].update(v)
        if last:
            rows[last]["provisional"] = True
        sources["ga"] = {"as_of": last, "pulled": today} if last else unavailable("the GA file covers none of these days")
    else:
        sources["ga"] = unavailable("no GA file was given")

    if a.ads:
        ads = ads_counts(a.ads)
        for d in days:
            if d in ads:
                rows[d].update(ads[d])
        covered = [d for d in days if d in ads]
        sources["ads"] = {"as_of": covered[-1], "pulled": today} if covered else unavailable("the ads file covers none of these days")
    else:
        sources["ads"] = unavailable("no Meta ads file was given")

    if a.ks_csv:
        ks = ks_followers(a.ks_csv)
        for d in days:
            if d in ks:
                rows[d]["ks_followers"] = ks[d]
        covered = [d for d in days if d in ks]
        sources["ks_followers"] = {"as_of": covered[-1], "pulled": today} if covered else unavailable("no follower reading on these days")
    else:
        sources["ks_followers"] = unavailable("no Kickstarter follower CSV was given")

    if a.ks_pageviews:
        pv, last = ks_pageviews(a.ks_pageviews)
        for d in days:
            if d in pv:
                rows[d]["ks_pageviews"] = pv[d]
        covered = [d for d in days if d in pv]
        sources["ks_pageviews"] = {"as_of": covered[-1], "pulled": today} if covered else unavailable("the page view files cover none of these days")
    else:
        sources["ks_pageviews"] = unavailable("no Meta PageView stats file was given")

    if today in rows:
        rows[today]["partial"] = True
    out["days"] = [rows[d] for d in reversed(days)]
    check_counts({**out, "days": [rows[d] for d in days]})
    return out


def main(argv=None):
    today = datetime.now(STOCKHOLM).date().isoformat()
    ap = argparse.ArgumentParser(description="Build data/tap10.json from pulled files. docs/TAP10.md")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--out", help="default <repo>/data/tap10.json")
    ap.add_argument("--since", default=LAUNCH)
    ap.add_argument("--until", default=today, help="last Stockholm day, default today (marked partial)")
    ap.add_argument("--today", default=today, help="for tests: what today is")
    ap.add_argument("--brevo-contacts", help="folder of Brevo contact pages as JSON")
    ap.add_argument("--ga", help="the four GA reports, as written by --ga-pull")
    ap.add_argument("--ga-pull", help="ask GA through gate ga report and save the raw reports here")
    ap.add_argument("--ga-property", default=GA_PROPERTY)
    ap.add_argument("--ads", action="append", help="[{date, spend_sek, link_clicks}], repeatable")
    ap.add_argument("--ks-csv", help="kickstarter-followers.csv")
    ap.add_argument("--ks-pageviews", action="append", help="raw Meta dataset stats for PageView, repeatable")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    for name in ("since", "until", "today"):
        if not DAY_RE.match(getattr(a, name)):
            ap.error(f"--{name} must be YYYY-MM-DD")
    if a.since > a.until:
        ap.error("--since is after --until")
    try:
        out = build(a)
    except Refused as err:
        print(f"refused, nothing written: {err}", file=sys.stderr)
        return 2
    path = a.out or os.path.join(a.repo, "data", "tap10.json")
    newest = out["days"][0]
    print(f"tap10: {len(out['days'])} days {a.since}..{a.until}, newest {newest['date']} signups {newest['signups']}, "
          + ", ".join(f"{k} {v.get('as_of') or 'unavailable'}" for k, v in out["sources"].items()))
    if a.dry_run:
        print("--dry-run: nothing written")
        return 0
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"written: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
