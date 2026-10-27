#!/usr/bin/env python3
"""Catalog coverage report for the .po files.

Compares one or more .po files against messages.pot:
  - untranslated: msgids present but with empty msgstr
  - missing:      msgids in the pot that have no entry at all
  - orphaned:     entries in a po that no longer exist in the pot
                  (stale — source string changed/removed)
  - duplicates:   same (msgctxt, msgid) pair appearing more than once (pot side)

Usage:
    python3 tools/i18n-report.py                      # de.po (legacy default)
    python3 tools/i18n-report.py --all                # every UI-registered language
    python3 tools/i18n-report.py --all --check        # gate: exit 1 on untranslated/missing
    python3 tools/i18n-report.py --po src/i18n/po/fr.po --check

--all derives the language list from `LANGUAGES` in src/i18n/plurals.ts
(en is the source catalog and is skipped). A language only enters LANGUAGES
once it is fully translated (translator workflow, Phase 5) — "registered"
therefore means "must be complete", which --check enforces.

--check blocks on untranslated + missing only. Orphaned entries and pot
duplicates are reported but never block (extract regenerates them; they do
not affect the shipped UI).
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

import polib

ROOT = Path(__file__).resolve().parent.parent
PO_DIR = ROOT / "src" / "i18n" / "po"
PLURALS_TS = ROOT / "src" / "i18n" / "plurals.ts"


def registered_languages() -> list[str]:
    """Parse the LANGUAGES keys from src/i18n/plurals.ts (en skipped)."""
    ts = PLURALS_TS.read_text(encoding="utf-8")
    match = re.search(r"export const LANGUAGES[^{]*\{(.*?)\};", ts, re.S)
    if not match:
        raise SystemExit("ERROR: could not parse LANGUAGES in src/i18n/plurals.ts")
    langs = re.findall(r"(\w+):\s*\{\s*nativeName", match.group(1))
    if not langs:
        raise SystemExit("ERROR: LANGUAGES in src/i18n/plurals.ts parsed to zero entries")
    return [lang for lang in langs if lang != "en"]


def analyze(pot, po) -> dict:
    pot_ids = {(e.msgctxt or "", e.msgid) for e in pot}
    po_ids = {(e.msgctxt or "", e.msgid) for e in po}

    missing = sorted(pot_ids - po_ids)
    orphaned = sorted(po_ids - pot_ids)

    untranslated = [
        e
        for e in po
        if (e.msgctxt or "", e.msgid) in pot_ids and not e.obsolete
        and (
            (not e.msgid_plural and not e.msgstr.strip())
            or (e.msgid_plural and not all(
                e.msgstr_plural.get(i, "").strip() for i in e.msgstr_plural
            ))
        )
    ]

    # Duplicate = same (msgctxt, msgid) pair appearing more than once.
    # Same msgid with DIFFERENT msgctxt is legitimate gettext usage (verb/noun
    # or per-case distinctions) and must NOT be flagged.
    key_counts = Counter((e.msgctxt, e.msgid) for e in pot)
    duplicates = sorted(m for m, c in key_counts.items() if c > 1)

    return {
        "pot_count": len(pot_ids),
        "translated": len(pot_ids) - len(missing) - len(untranslated),
        "missing": missing,
        "untranslated": untranslated,
        "orphaned": orphaned,
        "duplicates": duplicates,
        "key_counts": key_counts,
    }


def print_report(name: str, result: dict) -> None:
    print(f"== {name} ==")
    print(f"pot entries: {result['pot_count']}")
    print(f"translated:  {result['translated']}")
    print(f"missing:     {len(result['missing'])}")
    for m in result["missing"][:30]:
        ctx, msgid = m
        print(f"  - {(ctx + ':') if ctx else ''}{msgid[:90]}")
    print(f"untranslated:{len(result['untranslated'])}")
    for e in result["untranslated"][:30]:
        print(f"  ? {(e.msgctxt + ':') if e.msgctxt else ''}{e.msgid[:90]}")
    print(f"orphaned:    {len(result['orphaned'])}")
    for o in result["orphaned"][:20]:
        ctx, msgid = o
        print(f"  x {(ctx + ':') if ctx else ''}{msgid[:90]}")


def print_duplicates(result: dict) -> None:
    duplicates = result["duplicates"]
    print(f"duplicates in pot: {len(duplicates)}")
    for ctx, d in duplicates[:15]:
        print(f"  ! {(ctx + ':') if ctx else ''}{d[:90]}  (x{result['key_counts'][(ctx, d)]})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pot", default="src/i18n/po/messages.pot")
    ap.add_argument("--po", default="src/i18n/po/de.po")
    ap.add_argument("--all", action="store_true",
                    help="check every language registered in LANGUAGES (plurals.ts)")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 when untranslated or missing entries exist (gate)")
    args = ap.parse_args()

    pot = polib.pofile(str(ROOT / args.pot))

    targets: list[tuple[str, Path]] = []
    if args.all:
        for lang in registered_languages():
            po_path = PO_DIR / f"{lang}.po"
            if not po_path.exists():
                print(f"ERROR: language '{lang}' is registered in LANGUAGES "
                      f"but {po_path} is missing")
                return 1
            targets.append((lang, po_path))
    else:
        targets.append((Path(args.po).stem, ROOT / args.po))

    blocking = 0
    pot_result = None
    for name, po_path in targets:
        po = polib.pofile(str(po_path))
        result = analyze(pot, po)
        pot_result = result
        print_report(name, result)
        blocking += len(result["missing"]) + len(result["untranslated"])

    if pot_result:
        print_duplicates(pot_result)

    if args.check:
        if blocking:
            print(f"\nCHECK FAILED: {blocking} untranslated/missing entries — "
                  "translate them before committing.")
            return 1
        print("\nCheck passed: all registered languages fully translated.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
