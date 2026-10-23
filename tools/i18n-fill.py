#!/usr/bin/env python3
"""Fill empty msgstr entries in a .po file from a translation table.

Wrapping-, plural- and msgctxt-safe (polib based). Only fills entries whose
translation is still empty — existing translations are never overwritten.

Table format (JSON):
    {
      "msgid": "msgstr",
      ...
      "#ctx:msgid": "msgstr",            # msgctxt entry, key prefix "#"
      "*msgid": ["sing %s", "plur %s"],  # plural entry (list of 2)
      ...
    }

Usage:
    python3 tools/i18n-fill.py --table fills.json [--po src/i18n/po/de.po] [--compile]

--compile runs `bun run i18n:compile` after a successful fill.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import polib  # pip3 install --user --break-system-packages polib

ROOT = Path(__file__).resolve().parent.parent


def load_table(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", required=True, help="JSON file with translations")
    ap.add_argument("--po", default="src/i18n/po/de.po", help="target .po file")
    ap.add_argument("--compile", action="store_true", help="run i18n:compile after fill")
    args = ap.parse_args()

    po_path = ROOT / args.po
    po = polib.pofile(str(po_path), wrap_width=79)
    table = load_table(Path(args.table))

    filled: list[str] = []
    missed: list[str] = []
    plural_filled: list[str] = []
    ctx_filled: list[str] = []

    for key, value in table.items():
        ctx: str | None = None
        plural = False
        msgid = key
        if key.startswith("#"):
            msgid = key[1:]
            ctx, _, msgid = msgid.partition(":")
        if isinstance(value, list):
            plural = True

        entry = po.find(msgid, msgctxt=ctx)
        if entry is None:
            missed.append(key)
            continue
        if plural:
            if not entry.msgid_plural:
                missed.append(f"{key} (not plural in .po)")
                continue
            entry.msgstr_plural = {0: value[0], 1: value[1]}
            plural_filled.append(msgid)
        else:
            if entry.msgstr.strip():
                continue  # already translated — never overwrite
            entry.msgstr = value
            if ctx:
                ctx_filled.append(f"{ctx}:{msgid}")
            else:
                filled.append(msgid)

    po.save(str(po_path))

    print(f"filled:      {len(filled)}")
    for m in filled:
        print(f"  + {m}")
    if plural_filled:
        print(f"plurals:     {len(plural_filled)}")
        for m in plural_filled:
            print(f"  + {m}")
    if ctx_filled:
        print(f"msgctxt:     {len(ctx_filled)}")
        for m in ctx_filled:
            print(f"  + {m}")
    if missed:
        print(f"MISSED:      {len(missed)}  (not found / wrong shape)")
        for m in missed:
            print(f"  - {m}")

    empty_left = [e for e in po if not e.obsolete and not (
        (e.msgid_plural and all(e.msgstr_plural.get(i, "").strip() for i in e.msgstr_plural))
        or (not e.msgid_plural and e.msgstr.strip())
    )]
    if empty_left:
        print(f"\nstill empty in {po_path.name}: {len(empty_left)}")
        for e in empty_left[:20]:
            print(f"  ? {e.msgid[:80]}")

    if args.compile and not missed:
        subprocess.run(["bun", "run", "i18n:compile"], cwd=ROOT, check=False)

    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
