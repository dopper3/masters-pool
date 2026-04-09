#!/usr/bin/env python3
"""Generate bespoke cartoon avatars for each pool entry's display name.

Reads `data/entries.json`, finds every unique displayName that doesn't yet
have an avatar in `data/avatars/manifest.json`, calls OpenAI's DALL-E 3 image
generation API for each one with a flat-2D-cartoon prompt seeded by the name,
and saves the resulting PNG to `data/avatars/{slug}-{hash6}.png`. The manifest
maps displayName -> filename so the front-end can look it up cleanly without
having to recompute slugs.

Stdlib only — matches the convention in `scripts/fetch_scores.py` so the GHA
runner doesn't need a requirements file.

Usage:
    python scripts/generate_avatars.py            # backfill missing only
    python scripts/generate_avatars.py --force    # regenerate every avatar

Requires OPENAI_API_KEY in the environment.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENTRIES_PATH = ROOT / "data" / "entries.json"
AVATARS_DIR = ROOT / "data" / "avatars"
MANIFEST_PATH = AVATARS_DIR / "manifest.json"

OPENAI_URL = "https://api.openai.com/v1/images/generations"
OPENAI_MODEL = "dall-e-3"
OPENAI_SIZE = "1024x1024"
OPENAI_QUALITY = "standard"

# Visual style block, kept separate from the per-name riff so we can iterate
# on the look without touching the per-name logic. Avoids naming any
# copyrighted property directly so DALL-E doesn't refuse on style grounds.
STYLE_BLOCK = (
    "Flat 2D cartoon character portrait in a construction-paper cutout art "
    "style: oversized round head, simple oval eyes, minimal flat shading, "
    "bold solid colors, thick black outlines, plain solid white background. "
    "Head and shoulders only, character facing forward, centered composition. "
    "No text, no logos, no watermarks. The character should comedically and "
    "literally reflect the team name."
)


def slugify(name: str) -> str:
    """Filesystem-safe slug derived from a display name. Always suffixed with
    a 6-char hash of the original name so two different display names that
    collapse to the same slug never collide."""
    s = (name or "").lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    if not s:
        s = "x"
    h = hashlib.sha1((name or "").encode("utf-8")).hexdigest()[:6]
    return f"{s}-{h}"


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and "avatars" in data:
                    return data
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": 1, "avatars": {}}


def save_manifest(manifest: dict) -> None:
    AVATARS_DIR.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write("\n")


def load_display_names() -> list:
    if not ENTRIES_PATH.exists():
        return []
    with open(ENTRIES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    seen = set()
    names = []
    for entry in data.get("entries") or []:
        name = (entry.get("displayName") or "").strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    return names


def build_prompt(name: str) -> str:
    return (
        f"A cartoon avatar inspired by the team name '{name}'. "
        f"{STYLE_BLOCK}"
    )


def call_openai(prompt: str, api_key: str) -> str:
    """POST to /v1/images/generations and return the image URL."""
    body = json.dumps(
        {
            "model": OPENAI_MODEL,
            "prompt": prompt,
            "size": OPENAI_SIZE,
            "quality": OPENAI_QUALITY,
            "n": 1,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        OPENAI_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        payload = json.load(r)
    return payload["data"][0]["url"]


def download(url: str) -> bytes:
    req = urllib.request.Request(
        url, headers={"User-Agent": "masters-pool-avatars/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def generate_one(name: str, api_key: str) -> bytes | None:
    """Try to generate one avatar. Returns the PNG bytes, or None if the API
    refused (e.g. content moderation) so the caller can skip cleanly."""
    prompt = build_prompt(name)
    try:
        url = call_openai(prompt, api_key)
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        print(
            f"  ! OpenAI rejected '{name}' (HTTP {e.code}): {body[:200]}",
            file=sys.stderr,
        )
        return None
    except Exception as e:
        print(f"  ! Unexpected error for '{name}': {e}", file=sys.stderr)
        return None

    try:
        return download(url)
    except Exception as e:
        print(f"  ! Failed to download image for '{name}': {e}", file=sys.stderr)
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate every avatar even if one already exists in the manifest.",
    )
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY not set — refusing to run.", file=sys.stderr)
        sys.exit(2)

    AVATARS_DIR.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest()
    avatars = manifest.setdefault("avatars", {})

    names = load_display_names()
    print(f"Found {len(names)} unique display name(s) in entries.json", file=sys.stderr)

    generated = 0
    skipped = 0
    failed = 0

    for name in names:
        existing = avatars.get(name)
        if existing and not args.force:
            skipped += 1
            continue

        filename = f"{slugify(name)}.png"
        target = AVATARS_DIR / filename
        print(f"  → generating '{name}' -> {filename}", file=sys.stderr)

        png = generate_one(name, api_key)
        if png is None:
            failed += 1
            continue

        target.write_bytes(png)
        avatars[name] = filename
        generated += 1
        # Persist incrementally so a mid-run failure doesn't lose work.
        save_manifest(manifest)

    save_manifest(manifest)
    print(
        f"Done. generated={generated} skipped={skipped} failed={failed}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
