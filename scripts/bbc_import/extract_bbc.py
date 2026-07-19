#!/usr/bin/env python3
"""Extract + clean a BBC "6 Minute English" transcript PDF into plain text.

Read-only on the source: uses `pdftotext`, which parses copy-restricted PDFs
without needing a password (the BBC files are permission-restricted, not
open-password protected). This script never modifies, moves, or *executes*
anything in the source tree -- third-party downloaded material is treated as
data only.

Usage (single-file test):
    python3 extract_bbc.py "<episode>.pdf"

It prints the parsed title and the cleaned transcript to stdout so the result
can be eyeballed before any bulk import wiring is added.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# Page furniture that pdftotext emits on every page -- not transcript content.
BOILERPLATE = [
    re.compile(r"^\s*BBC LEARNING ENGLISH\s*$", re.I),
    re.compile(r"^\s*6\s*Minute English\s*$", re.I),
    re.compile(r"bbclearningenglish\.com", re.I),
    re.compile(r"British Broadcasting Corporation", re.I),
    re.compile(r"^\s*Page\s+\d+\s+of\s+\d+\s*$", re.I),
    re.compile(r"word-for-word transcript", re.I),
]

# The transcript is pure English, so any line carrying CJK characters is an
# injected reseller watermark/ad (e.g. the "微信…会员" promo). Drop the line.
CJK = re.compile(r"[一-鿿぀-ヿ＀-￯]")

_TITLE_STOP = re.compile(r"word-for-word transcript", re.I)


def extract_text(pdf: Path) -> str:
    """Run pdftotext on the PDF and return its stdout (UTF-8 text)."""
    result = subprocess.run(
        ["pdftotext", str(pdf), "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def parse_title(lines: list[str]) -> str | None:
    """The episode title is the last real line before 'not a word-for-word
    transcript' (for the Yawning episode: the line 'Yawning')."""
    for idx, line in enumerate(lines):
        if _TITLE_STOP.search(line):
            for j in range(idx - 1, -1, -1):
                cand = lines[j].strip()
                if not cand or CJK.search(cand):
                    continue
                if any(p.search(cand) for p in BOILERPLATE):
                    continue
                return cand
            break
    return None


def clean_body(raw: str) -> str:
    """Strip boilerplate + ad lines and collapse runs of blank lines."""
    out: list[str] = []
    for line in raw.replace("\r\n", "\n").split("\n"):
        s = line.strip()
        if CJK.search(s):
            continue
        if any(p.search(s) for p in BOILERPLATE):
            continue
        out.append(s)
    # Collapse 2+ blank lines into a single paragraph break.
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def process(pdf: Path) -> tuple[str | None, str]:
    raw = extract_text(pdf)
    lines = raw.replace("\r\n", "\n").split("\n")
    return parse_title(lines), clean_body(raw)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    pdf = Path(argv[1])
    if not pdf.is_file():
        print(f"not a file: {pdf}", file=sys.stderr)
        return 1
    title, body = process(pdf)
    print(f"===== TITLE: {title!r} =====")
    print(f"===== BODY ({len(body)} chars) =====")
    print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
