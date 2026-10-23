#!/usr/bin/env python3
"""Catalog coverage report for the .po files.

Compares de.po against messages.pot:
  - untranslated: msgids present but with empty msgstr
  - missing:      msgids in the pot that have no entry at all
  - orphaned:     entries in de.po that no longer exist in the pot
                  (stale — source string changed/removed)
  - duplicates:   same msgid appearing more than once (pot side)

Usage:
    python3 tools/i18n-report.py [--pot src/i18n/po/messages.pot] [--po src/i18n/po/de.po]
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

import polib

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pot", default="src/i18n/po/messages.pot")
    ap.add_argument("--po", default="src/i18n/po/de.po")
    args = ap.parse_args()

    pot = polib.pofile(str(ROOT / args.pot))
    po = polib.pofile(str(ROOT / args.po))

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

    id_counts = Counter(e.msgid for e in pot)
    duplicates = sorted(m for m, c in id_counts.items() if c > 1)

    print(f"pot entries: {len(pot_ids)}")
    print(f"translated:  {len(pot_ids) - len(missing) - len(untranslated)}")
    print(f"missing:     {len(missing)}")
    for m in missing[:30]:
        ctx, msgid = m
        print(f"  - {(ctx + ':') if ctx else ''}{msgid[:90]}")
    print(f"untranslated:{len(untranslated)}")
    for e in untranslated[:30]:
        print(f"  ? {(e.msgctxt + ':') if e.msgctxt else ''}{e.msgid[:90]}")
    print(f"orphaned:    {len(orphaned)}")
    for o in orphaned[:20]:
        ctx, msgid = o
        print(f"  x {(ctx + ':') if ctx else ''}{msgid[:90]}")
    print(f"duplicates in pot: {len(duplicates)}")
    for d in duplicates[:15]:
        print(f"  ! {d[:90]}  (x{id_counts[d]})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
