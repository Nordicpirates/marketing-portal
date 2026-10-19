"""Landing-page names from data/landing-page-names.json, the only place a page gets its name.
Renaming one is an edit there plus the next refresh. Docs: docs/DAILY-REFRESH.md."""

import collections
import json
import os

NAMES_FILE = os.path.join("data", "landing-page-names.json")


def load(repo="."):
    """{lowercased path: (path as written in the file, name, group)}."""
    raw = json.load(open(os.path.join(repo, NAMES_FILE)))
    out = {}
    for path, entry in raw.items():
        key = key_of(path)
        if key in out:
            raise SystemExit(f"{NAMES_FILE} names {path} twice (paths match case-insensitively)")
        if not (entry.get("name") or "").strip():
            raise SystemExit(f"{NAMES_FILE}: {path} has no name")
        out[key] = (path, entry["name"].strip(), entry.get("group"))
    return out


def key_of(path):
    # GA4 reports /lp/Q4 and /lp/q4 as two pages, and a trailing slash as a third.
    return (path.strip().rstrip("/") or "/").lower()


def name_for(names, path):
    """The page's name, or its own path when the file does not know it."""
    hit = names.get(key_of(path))
    return hit[1] if hit else path


def canonical(names, path):
    """The names file's spelling of a path it knows, else the path as given."""
    hit = names.get(key_of(path))
    return hit[0] if hit else path


def merge(names, rows):
    """[(path, sessions, purchases)] to {canonical path: [sessions, purchases]}, case variants summed.
    The canonical spelling is the names file's, else the variant with the most sessions."""
    totals = collections.defaultdict(lambda: [0, 0])
    spellings = collections.defaultdict(collections.Counter)
    for path, sessions, purchases in rows:
        key = key_of(path)
        totals[key][0] += sessions
        totals[key][1] += purchases
        spellings[key][path.strip().rstrip("/") or "/"] += sessions
    out = {}
    for key, pair in totals.items():
        known = names.get(key)
        out[known[0] if known else spellings[key].most_common(1)[0][0]] = pair
    return out
