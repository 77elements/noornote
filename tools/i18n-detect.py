#!/usr/bin/env python3
"""Detect raw UI strings in src/ that are not wrapped in _()/tp()/tn().

The gettext extractor only sees literal `_()` calls. Strings stored as data
(dropdown labels, tile specs, `textContent = '...'`, template-literal tag
bodies, placeholders) silently stay English. This script flags the common
shapes so nothing depends on users reporting them one by one.

Usage:
    python3 tools/i18n-detect.py                # report to stdout
    python3 tools/i18n-detect.py --check        # exit 1 when hits exist (CI gate)

Heuristics are intentionally conservative (few false positives), so the
report under-reports rather than over-reports.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"

# One JS string literal: '…' or "…", with escaped-char support.
STR = r"(?:[^'\"\\\n]|\\.)*"

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # Object data fields that typically carry UI text: label/title/name/…
    (
        "data-label",
        re.compile(
            r"(?<![_$'\"])(?:label|title|placeholderText|text)\s*:\s*['\"]("
            f"{STR})['\"]"
        ),
    ),
    # DOM text assignments
    (
        "textContent",
        re.compile(
            r"textContent(?:\s*\|\|\s*['\"]{2})?\s*=\s*['\"](" f"{STR})['\"]"
        ),
    ),
    (
        "innerText",
        re.compile(r"innerText\s*=\s*['\"](" f"{STR})['\"]"),
    ),
    # HTML attributes inside template literals
    (
        "placeholder-attr",
        re.compile(r"placeholder=\"([^\"]+)\""),
    ),
    (
        "title-attr",
        re.compile(r"\stitle=\"([^\"]+)\""),
    ),
    (
        "aria-label",
        re.compile(r"aria-label=\"([^\"]+)\""),
    ),
    # >Text< between tags in template literals (needs a space to avoid
    # single-word markup like <b>x</b>; catches ">Add note<")
    (
        "tag-body",
        re.compile(r">([A-Z][A-Za-z0-9 ,.:;!?%\-/()äöüßÄÖÜ&'’]{2,60})<"),
    ),
    # Plain assignments/args: toast('...'), showError('...'), alert('...'),
    # confirm('...'), prompt('...')
    (
        "toast-or-dialog",
        re.compile(
            r"\b(?:toast|showError|showWarning|showInfo|alert|confirm|prompt)"
            rf"\(\s*['\"]({STR})['\"]"
        ),
    ),
]

# Keys whose values are NOT UI text (identifiers, event names, css, …).
NON_UI_KEYS = {"id", "key", "name", "action", "event", "type", "kind", "url", "icon"}

# Strings that are identifiers/technical even when they sit in a text slot.
NON_TEXT = re.compile(
    r"^(?:"
    r"[a-z0-9_\-:.]+$"  # kebab/snake/plain identifiers, CSS, event names
    r"|[A-Z0-9_]{3,}$"  # CONSTANTS
    r"|[a-z]+://\S+$"  # URLs, bunker://…
    r"|npub1\S*|note1\S*|nevent1\S*|nprofile1\S*"  # bech32
    r"|[A-Fa-f0-9]{16,}$"  # hex
    r"|\d+$"  # pure numbers
    r")"
)


def iter_files() -> list[Path]:
    files = [
        p
        for p in SRC.rglob("*.ts")
        if not p.name.endswith(".test.ts") and "/i18n/" not in str(p)
    ]
    return sorted(files)


def is_candidate(s: str) -> bool:
    if len(s.strip()) < 2:
        return False
    if NON_TEXT.match(s.strip()):
        return False
    # Must contain at least one ASCII letter; must start uppercase to qualify
    # as UI copy (conservative).
    if not s.strip()[0].isupper():
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--check",
        action="store_true",
        help="exit with code 1 when untranslated hits exist",
    )
    args = ap.parse_args()

    hits: list[tuple[Path, int, str, str]] = []
    for path in iter_files():
        src = path.read_text(encoding="utf-8")
        lines = src.splitlines()
        for i, line in enumerate(lines):
            lineno = i + 1
            # Skip import lines and comments.
            stripped = line.strip()
            if stripped.startswith("//") or stripped.startswith("*"):
                continue
            if "i18n-ok" in line:
                continue  # explicitly marked as intentional (brand/anchored/data-level)
            for kind, pat in PATTERNS:
                # Tag bodies are often parts of already-translated literals
                # (e.g. `_('<strong>NoorNote</strong> is built on …')`) —
                # skip when this or the previous line already wraps with _().
                if kind == "tag-body" and (
                    re.search(r"\b_\(?'", line)
                    or (i > 0 and re.search(r"_\(\s*$", lines[i - 1]))
                ):
                    continue
                for m in pat.finditer(line):
                    val = m.group(1)
                    if not is_candidate(val):
                        continue
                    # Entire line already translated (contains _(...) wrapping
                    # the same literal) → skip.
                    rel = path.relative_to(SRC.parent)
                    hits.append((rel, lineno, kind, val))

    # Dedupe (same file/line/value via different pattern kinds).
    seen: set[tuple, bool] = set()
    uniq: list[tuple[Path, int, str, str]] = []
    for h in hits:
        key = (h[0], h[1], h[3])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(h)

    for rel, lineno, kind, val in uniq:
        print(f"{rel}:{lineno}: [{kind}] {val[:100]}")

    print(f"\n{len(uniq)} possible untranslated string(s) in {len(iter_files())} file(s)")
    return 1 if args.check and uniq else 0


if __name__ == "__main__":
    sys.exit(main())
