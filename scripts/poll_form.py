#!/usr/bin/env python3
"""Pull pool entries from a Google Form's published-CSV sheet and merge them
into data/entries.json under source="form".

Stateless: every run rewrites all source="form" entries from scratch based on
what's currently in the sheet. github-issue entries are left untouched.

Usage:
    FORM_CSV_URL=https://docs.google.com/.../pub?output=csv python scripts/poll_form.py

If FORM_CSV_URL is empty or unset, exits 0 with a "not configured" message so
the workflow can run safely before you've wired up a form.
"""
import csv
import io
import json
import os
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENTRIES_FILE = ROOT / "data" / "entries.json"
SCORES_FILE = ROOT / "data" / "scores.json"

PICKS_REQUIRED = 6


# ---------- helpers (intentionally duplicated from ingest_entry.py to keep
# the two ingest paths independent and avoid cross-script breakage) ----------

def slug(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s


def match_pick(pick_text, field):
    pick_text = (pick_text or "").strip()
    if not pick_text:
        raise ValueError("empty pick")
    target = slug(pick_text)
    if not target:
        raise ValueError(f"unparseable pick: {pick_text!r}")

    exact = [p for p in field if slug(p.get("name")) == target]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ValueError(f"{pick_text!r} matches multiple players exactly")

    contains = [p for p in field if target in slug(p.get("name"))]
    if len(contains) == 1:
        return contains[0]

    parts = target.split()
    if len(parts) == 1:
        last = [p for p in field if slug(p.get("name")).split()[-1] == parts[0]]
        if len(last) == 1:
            return last[0]

    if not contains:
        raise ValueError(f"no field player matches {pick_text!r}")
    names = ", ".join(p["name"] for p in contains[:6])
    raise ValueError(f"{pick_text!r} is ambiguous — could be: {names}")


# ---------- CSV parsing ----------

# Loose column header matching: tries the canonical key first, then falls back
# to a substring search.
PICK_HEADER_RE = re.compile(r"^pick\s*0*([1-6])\b", re.IGNORECASE)


def find_column(headers, *candidates):
    """Return the actual header in `headers` that loosely matches any candidate."""
    norm = {h: slug(h) for h in headers}
    for cand in candidates:
        c = slug(cand)
        for h, n in norm.items():
            if n == c:
                return h
    for cand in candidates:
        c = slug(cand)
        for h, n in norm.items():
            if c in n:
                return h
    return None


def find_pick_columns(headers):
    """Return a 6-list of headers for pick 1..6 (None if missing)."""
    cols = [None] * 6
    for h in headers:
        m = PICK_HEADER_RE.match(h.strip())
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < 6 and cols[idx] is None:
                cols[idx] = h
    return cols


def parse_form_timestamp(s):
    """Best-effort parse of Google Forms' default timestamp format."""
    if not s:
        return None
    s = s.strip()
    formats = [
        "%m/%d/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%m/%d/%Y %H:%M",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return s  # give up, store the raw string


# ---------- IO ----------

def fetch_csv(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "masters-pool-form-poller/1.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    # Google Sheets CSV is utf-8; tolerate a BOM
    return raw.decode("utf-8-sig")


def load_field():
    if not SCORES_FILE.exists():
        raise SystemExit(
            f"{SCORES_FILE} not found. Run scripts/fetch_scores.py first."
        )
    data = json.loads(SCORES_FILE.read_text(encoding="utf-8"))
    return data.get("players") or []


def load_entries():
    if ENTRIES_FILE.exists():
        return json.loads(ENTRIES_FILE.read_text(encoding="utf-8"))
    return {"entries": []}


def save_entries(data):
    ENTRIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    ENTRIES_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


# ---------- main ----------

def process_rows(rows, headers, field):
    """Yield (entry_dict | None, log_line) for each row."""
    name_col = find_column(headers, "display name", "name")
    pick_cols = find_pick_columns(headers)
    ts_col = find_column(headers, "timestamp")

    if not name_col:
        raise SystemExit(
            "Form CSV is missing a 'Display name' column. Add a short-answer "
            "question titled 'Display name' to your Google Form."
        )
    missing_picks = [i + 1 for i, c in enumerate(pick_cols) if c is None]
    if missing_picks:
        raise SystemExit(
            f"Form CSV is missing pick columns: {missing_picks}. Each form needs "
            "six short-answer questions named 'Pick 1' through 'Pick 6'."
        )

    for row in rows:
        display_name = (row.get(name_col) or "").strip()
        if not display_name:
            yield None, "skipped row with no display name"
            continue

        picks_text = [(row.get(c) or "").strip() for c in pick_cols]
        if not all(picks_text):
            yield None, f"{display_name!r}: missing one or more picks — skipped"
            continue

        try:
            resolved = [match_pick(pt, field) for pt in picks_text]
        except ValueError as e:
            yield None, f"{display_name!r}: {e} — skipped"
            continue

        ids = [r["id"] for r in resolved]
        if len(set(ids)) != len(ids):
            yield None, f"{display_name!r}: duplicate golfer in picks — skipped"
            continue

        entry = {
            "source": "form",
            "displayName": display_name,
            "submittedAt": parse_form_timestamp(row.get(ts_col, "")) or None,
            "picks": [{"id": p["id"], "name": p["name"]} for p in resolved],
        }
        yield entry, f"{display_name!r}: ok"


def main():
    url = (os.environ.get("FORM_CSV_URL") or "").strip()
    if not url:
        if len(sys.argv) > 1:
            url = sys.argv[1]
    if not url:
        print(
            "FORM_CSV_URL not set — form ingestion is not configured. "
            "Skipping. (Set the FORM_CSV_URL repo variable to enable.)",
            file=sys.stderr,
        )
        return 0

    print(f"Fetching form CSV from {url}", file=sys.stderr)
    csv_text = fetch_csv(url)
    reader = csv.DictReader(io.StringIO(csv_text))
    headers = reader.fieldnames or []
    if not headers:
        raise SystemExit("CSV had no header row — is the form connected to a sheet?")

    rows = list(reader)
    print(f"Read {len(rows)} form rows.", file=sys.stderr)

    field = load_field()
    if not field:
        raise SystemExit("Field is empty in scores.json — cannot validate picks.")

    new_form_entries = []
    accepted = 0
    rejected = 0
    for entry, log in process_rows(rows, headers, field):
        print("  " + log, file=sys.stderr)
        if entry is None:
            rejected += 1
        else:
            new_form_entries.append(entry)
            accepted += 1

    # Dedup by display name slug — latest submission wins. Sort the rows by
    # parsed timestamp ascending so the later ones overwrite the earlier ones.
    def ts_key(e):
        ts = e.get("submittedAt") or ""
        return ts

    new_form_entries.sort(key=ts_key)
    by_slug = {}
    for e in new_form_entries:
        by_slug[slug(e["displayName"])] = e
    deduped = list(by_slug.values())

    if accepted != len(deduped):
        print(
            f"Deduped to {len(deduped)} unique displayName entries "
            f"(latest submission wins).",
            file=sys.stderr,
        )

    data = load_entries()
    existing = data.get("entries", [])
    # Keep everything that ISN'T from the form
    kept = [e for e in existing if e.get("source") != "form"]
    data["entries"] = kept + deduped
    save_entries(data)

    print(
        f"Wrote entries.json: {len(deduped)} form entries + {len(kept)} other.",
        file=sys.stderr,
    )
    print(
        f"Summary: accepted={accepted} rejected={rejected} unique={len(deduped)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
