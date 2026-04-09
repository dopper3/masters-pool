#!/usr/bin/env python3
"""Parse a GitHub issue body submitted from the pool-entry form template,
validate the picks against the current field, and append/update the entry in
data/entries.json.

Designed to be invoked by the ingest-entry GitHub Actions workflow with the
issue body piped in via stdin (or passed as a file path).

Usage:
    python scripts/ingest_entry.py --issue-number 7 --issue-user alice < body.md
    python scripts/ingest_entry.py --issue-number 7 --issue-user alice --body-file body.md
"""
import argparse
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENTRIES_FILE = ROOT / "data" / "entries.json"
SCORES_FILE = ROOT / "data" / "scores.json"


def slug(s):
    """Loose normalization for fuzzy name matching."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s


def parse_form_body(body):
    """Parse a GitHub issue-form body. Form fields render as:

        ### Display name
        <user value>

        ### Pick 1
        <golfer name>

    Returns a dict mapping lowercased headings to their value strings.
    """
    fields = {}
    current = None
    buf = []
    for raw in body.splitlines():
        line = raw.rstrip()
        m = re.match(r"^#{2,4}\s+(.*?)\s*$", line)
        if m:
            if current is not None:
                fields[current] = "\n".join(buf).strip()
            current = m.group(1).strip().lower()
            buf = []
        else:
            buf.append(line)
    if current is not None:
        fields[current] = "\n".join(buf).strip()

    # GitHub form widgets sometimes render "_No response_" for empty fields
    for k, v in list(fields.items()):
        if v.strip() in ("_No response_", "_No response_\r"):
            fields[k] = ""
    return fields


def load_field():
    if not SCORES_FILE.exists():
        raise SystemExit(
            f"{SCORES_FILE} not found. Run scripts/fetch_scores.py first."
        )
    data = json.loads(SCORES_FILE.read_text(encoding="utf-8"))
    return data.get("players") or []


def match_pick(pick_text, field):
    """Resolve a free-text pick to a player in the field. Returns the player dict
    or raises ValueError if no unique match is found."""
    pick_text = (pick_text or "").strip()
    if not pick_text:
        raise ValueError("empty pick")

    target = slug(pick_text)
    if not target:
        raise ValueError(f"could not parse pick: {pick_text!r}")

    # 1. Exact slug match on full name
    exact = [p for p in field if slug(p.get("name")) == target]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ValueError(f"{pick_text!r} matches multiple players exactly")

    # 2. Substring on full name (target ⊆ name)
    contains = [p for p in field if target in slug(p.get("name"))]
    if len(contains) == 1:
        return contains[0]

    # 3. Last-name match if only one token
    parts = target.split()
    if len(parts) == 1:
        last = [p for p in field if slug(p.get("name")).split()[-1] == parts[0]]
        if len(last) == 1:
            return last[0]

    if not contains:
        raise ValueError(f"no player in the field matches {pick_text!r}")
    names = ", ".join(p["name"] for p in contains[:6])
    raise ValueError(
        f"{pick_text!r} is ambiguous — could be: {names}. Use the full name."
    )


def load_entries():
    if ENTRIES_FILE.exists():
        return json.loads(ENTRIES_FILE.read_text(encoding="utf-8"))
    return {"entries": []}


def save_entries(data):
    ENTRIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    ENTRIES_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--issue-number", type=int, required=True)
    ap.add_argument("--issue-user", required=True, help="GitHub login of issue author")
    ap.add_argument("--body-file", help="Path to file containing issue body")
    args = ap.parse_args()

    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    else:
        body = sys.stdin.read()

    fields = parse_form_body(body)

    display_name = fields.get("display name") or args.issue_user
    pick_keys = [f"pick {i}" for i in range(1, 7)]
    pick_texts = [fields.get(k, "") for k in pick_keys]

    if not all(pick_texts):
        missing = [k for k, v in zip(pick_keys, pick_texts) if not v]
        raise SystemExit(f"Entry is missing picks for: {', '.join(missing)}")

    field = load_field()
    if not field:
        raise SystemExit("Field is empty in scores.json — cannot validate picks.")

    resolved = []
    errors = []
    for i, pt in enumerate(pick_texts, 1):
        try:
            p = match_pick(pt, field)
            resolved.append({"id": p["id"], "name": p["name"]})
        except ValueError as e:
            errors.append(f"  Pick {i}: {e}")

    if errors:
        raise SystemExit("Could not validate entry:\n" + "\n".join(errors))

    # Reject duplicate picks within a single entry
    ids = [r["id"] for r in resolved]
    if len(set(ids)) != len(ids):
        raise SystemExit("You picked the same golfer more than once.")

    data = load_entries()
    entries = data.setdefault("entries", [])

    # If the same issue author already has an entry, replace it (resubmits allowed
    # until the tournament locks)
    entries = [e for e in entries if e.get("githubUser") != args.issue_user]
    entries.append(
        {
            "displayName": display_name,
            "githubUser": args.issue_user,
            "issueNumber": args.issue_number,
            "submittedAt": datetime.now(timezone.utc).isoformat(),
            "picks": resolved,
        }
    )
    data["entries"] = entries
    save_entries(data)

    print(f"Accepted entry from @{args.issue_user} ({display_name}):")
    for r in resolved:
        print(f"  - {r['name']}")


if __name__ == "__main__":
    main()
