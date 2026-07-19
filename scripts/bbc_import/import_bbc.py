#!/usr/bin/env python3
"""Import BBC "6 Minute English" episodes into listen-panel as materials.

Per episode: pair the transcript PDF with its mp3 (by the YYMMDD date token in
the filename), extract + clean the transcript (extract_bbc.process), then push
it through the app's own HTTP API:

    POST /api/auth/login    -> obtain a session cookie
    POST /api/upload        -> store the mp3, get back its stored filename
    POST /api/materials     -> create the material with text pre-filled

Creating a material never triggers ASR, so the official transcript is used
as-is and no transcription runs.

Safety / design:
  * Stdlib only (urllib + http.cookiejar) -- nothing to pip-install.
  * Read-only on the source tree; files are opened as data, never executed.
  * DEFAULT IS --dry-run: it only pairs/extracts/reports. Pass --commit to
    actually log in and write. --commit needs credentials from env
    (LP_USER / LP_PASS) or an interactive prompt; the password is never
    hardcoded or logged.
  * Idempotent: each material records `src: <pdf-stem>` in its notes; a second
    run skips episodes whose src key already exists.
  * Completeness gate: an episode is imported only if it has a paired mp3 that
    is >= MIN_MP3 bytes (skips the still-downloading half of the collection).

Usage:
    # inspect what would be imported (no backend needed):
    python3 import_bbc.py --dir "<BBC root>" --dry-run

    # actually import (backend must be running; you'll be asked for password):
    LP_USER=me python3 import_bbc.py --dir "<BBC root>" --commit
"""
from __future__ import annotations

import argparse
import getpass
import http.cookiejar
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

import extract_bbc

DEFAULT_BASE = "/Users/voyager/Downloads/BBC六分钟英语"
DEFAULT_API = "http://localhost:9527"

# A full ~6-minute mp3 is >=1.5 MB even at low bitrate; anything smaller is a
# truncated/incomplete download and gets skipped.
MIN_MP3 = 500_000

DATE_RE = re.compile(r"(\d{6})")


@dataclass
class Episode:
    date_iso: str          # 2020-01-02
    stem: str              # pdf filename without extension (provenance key)
    pdf: Path
    mp3: Path
    mp3_size: int


def iso_date(yymmdd: str) -> str:
    """081029 -> 2008-10-29 (all episodes are 2008-2024)."""
    return f"20{yymmdd[0:2]}-{yymmdd[2:4]}-{yymmdd[4:6]}"


_TITLE_JUNK = re.compile(
    r"\b(?:6\s*min(?:ute)?|six\s*minute|english|for_?web|au|bb|download|mp3|web)\b",
    re.I,
)


def title_from_stem(stem: str) -> str:
    """Human title from a filename when the PDF has no parseable title line,
    e.g. '6minute_080813_cost_of_living' -> 'Cost of living'."""
    s = re.sub(r"\d{6}", " ", stem)              # drop the YYMMDD date token
    s = s.replace("_", " ").replace("-", " ")
    s = _TITLE_JUNK.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return stem
    return s[0].upper() + s[1:]


def folder_title(pdf: Path) -> str | None:
    """Per-episode folders are named 'YYMMDD Title' -- pull out 'Title', which
    is usually cleaner than the file-derived one (e.g. 'A good night's rest'
    vs 'Sleep pdf 3'). Flat year folders like '2020 6分钟英语' don't match, and
    the date itself stays sourced from the filename (folder dates are batch
    dates: 9 episodes can share one)."""
    m = re.match(r"\d{6}[\s_-]+(.+)$", pdf.parent.name)
    if m:
        return m.group(1).strip() or None
    return None


def pick_mp3(pdf: Path, date6: str) -> Path | None:
    """Find the mp3 for a transcript PDF by the shared YYMMDD date token.

    Works for both layouts: per-episode subfolders (the single mp3 shares the
    pdf's date) and flat year folders (many mp3s, matched on date). We do NOT
    fall back to an arbitrary mp3 when no same-date file exists -- pairing the
    wrong audio to a transcript would silently corrupt shadowing practice, so a
    missing same-date mp3 just means "not downloaded yet" and the episode is
    skipped. When several share the date (rare), the largest wins."""
    dated = [p for p in pdf.parent.glob("*.mp3") if date6 in p.name]
    if not dated:
        return None
    return max(dated, key=lambda p: p.stat().st_size)


def discover(base: Path) -> tuple[list[Episode], list[tuple[Path, str]]]:
    """Walk the tree and pair every transcript PDF with its mp3.

    Returns (importable, skipped) where skipped is (pdf, reason)."""
    importable: list[Episode] = []
    skipped: list[tuple[Path, str]] = []
    for pdf in sorted(base.rglob("*.pdf")):
        m = DATE_RE.search(pdf.name)
        if not m:
            skipped.append((pdf, "no date token in filename"))
            continue
        date6 = m.group(1)
        mp3 = pick_mp3(pdf, date6)
        if mp3 is None:
            skipped.append((pdf, "no mp3 in folder (not downloaded yet)"))
            continue
        size = mp3.stat().st_size
        if size < MIN_MP3:
            skipped.append((pdf, f"mp3 too small ({size} B) — incomplete"))
            continue
        importable.append(
            Episode(
                date_iso=iso_date(date6),
                stem=pdf.stem,
                pdf=pdf,
                mp3=mp3,
                mp3_size=size,
            )
        )
    return importable, skipped


# --------------------------------------------------------------------------- #
# HTTP (stdlib) with a persistent session cookie
# --------------------------------------------------------------------------- #

def make_opener() -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def _read_error(e: urllib.error.HTTPError) -> str:
    try:
        return e.read().decode("utf-8", "replace")[:300]
    except Exception:
        return ""


def post_json(opener, url: str, obj: dict):
    data = json.dumps(obj).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    with opener.open(req) as r:
        body = r.read()
    return json.loads(body) if body else None


def get_json(opener, url: str):
    with opener.open(url) as r:
        return json.loads(r.read())


def upload_file(opener, api: str, path: Path) -> str:
    """POST the mp3 as multipart/form-data field 'file'; return stored name."""
    boundary = "----bbcimport" + uuid.uuid4().hex
    filename = path.name
    payload = path.read_bytes()
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: audio/mpeg\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    body = head + payload + tail
    req = urllib.request.Request(f"{api}/api/upload", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with opener.open(req) as r:
        resp = json.loads(r.read())
    return resp["file"]


def existing_src_keys(opener, api: str) -> set[str]:
    """Provenance keys already imported, so re-runs skip them."""
    keys: set[str] = set()
    for mat in get_json(opener, f"{api}/api/materials"):
        for line in (mat.get("notes") or "").splitlines():
            line = line.strip()
            if line.startswith("src:"):
                keys.add(line[len("src:"):].strip())
    return keys


def build_notes(ep: Episode) -> str:
    return f"BBC 6 Minute English\ndate: {ep.date_iso}\nsrc: {ep.stem}"


# --------------------------------------------------------------------------- #

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", default=DEFAULT_BASE, help="BBC collection root")
    ap.add_argument("--api", default=DEFAULT_API, help="backend base URL")
    ap.add_argument("--commit", action="store_true",
                    help="actually import (default: dry-run)")
    ap.add_argument("--limit", type=int, default=0, help="cap episodes (0=all)")
    ap.add_argument("--only", default="",
                    help="only episodes whose pdf stem contains this substring")
    args = ap.parse_args(argv[1:])

    base = Path(args.dir)
    if not base.is_dir():
        print(f"not a directory: {base}", file=sys.stderr)
        return 1

    importable, skipped = discover(base)
    if args.only:
        importable = [e for e in importable if args.only in e.stem]
    importable.sort(key=lambda e: (e.date_iso, e.stem))
    total = len(importable)
    if args.limit:
        importable = importable[: args.limit]

    print(f"scanned {base}")
    print(f"  importable episodes : {total}"
          + (f"  (processing first {len(importable)})" if args.limit else ""))
    print(f"  skipped (incomplete): {len(skipped)}")
    print()

    if not args.commit:
        print("DRY RUN — no login, no writes. Preview:\n")
        for ep in importable:
            title, body = extract_bbc.process(ep.pdf)
            name = folder_title(ep.pdf) or title or title_from_stem(ep.stem)
            print(f"  [{ep.date_iso}] {name}")
            print(f"      pdf : {ep.pdf.name}")
            print(f"      mp3 : {ep.mp3.name}  ({ep.mp3_size//1024} KB)")
            print(f"      text: {len(body)} chars")
        print("\nRe-run with --commit (backend up) to import.")
        return 0

    # ---- commit path: needs a running backend + credentials ----
    username = os.environ.get("LP_USER") or input("listen-panel username: ").strip()
    password = os.environ.get("LP_PASS") or getpass.getpass("listen-panel password: ")

    opener = make_opener()
    try:
        post_json(opener, f"{args.api}/api/auth/login",
                  {"username": username, "password": password})
    except urllib.error.HTTPError as e:
        print(f"login failed: HTTP {e.code} {_read_error(e)}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"cannot reach backend at {args.api}: {e}", file=sys.stderr)
        return 1

    seen = existing_src_keys(opener, args.api)
    inserted = skipped_dup = failed = 0
    for ep in importable:
        if ep.stem in seen:
            skipped_dup += 1
            continue
        try:
            title, body = extract_bbc.process(ep.pdf)
            name = folder_title(ep.pdf) or title or title_from_stem(ep.stem)
            stored = upload_file(opener, args.api, ep.mp3)
            post_json(opener, f"{args.api}/api/materials", {
                "title": name,
                "language": "en",
                "source_type": "local",
                "source_ref": stored,
                "text": body,
                "notes": build_notes(ep),
            })
            inserted += 1
            print(f"  + [{ep.date_iso}] {name}")
        except urllib.error.HTTPError as e:
            failed += 1
            print(f"  ! {ep.stem}: HTTP {e.code} {_read_error(e)}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001 - report and continue the batch
            failed += 1
            print(f"  ! {ep.stem}: {e}", file=sys.stderr)

    print(f"\ninserted {inserted}, skipped-duplicate {skipped_dup}, failed {failed}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
