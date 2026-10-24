#!/usr/bin/env python3
"""Export untranslated .po entries to an XLSX translation sheet (WP13, D6).

The community workflow (docs/todos/internationalization.md §7.7): translators
fill one column in Excel/Google Sheets and send the file back; the import
tool (i18n-sheet-import.py) validates and integrates it. No third-party
service, no accounts.

Sheet layout (row 1 = header, data from row 2):
    A  Key (msgid)                  — match key for the import, do not edit
    B  Context (msgctxt)            — empty when the string has no context
    C  Form                         — "Singular" or "Plural"
    D  English                      — source string (msgid)
    E  English (plural)             — msgid_plural, plural rows only
    F  German (reference)           — de.po msgstr, orientation only
    G  German (plural)              — de.po msgstr_plural[1]
    H  Suggestion (MT draft)        — current msgstr of a fuzzy entry
    I  Suggestion (plural)          — fuzzy msgstr_plural[1]
    J  YOUR TRANSLATION             — fill this
    K  YOUR TRANSLATION (plural)    — fill this (plural rows)

Default scope: untranslated + fuzzy entries only (the work list).
`--all` exports every entry including already-final translations.

If `src/i18n/po/<lang>.po` does not exist yet, it is bootstrapped from the
pot automatically (msginit equivalent, Language header set).

Usage:
    python3 tools/i18n-sheet-export.py --lang ar [--all] [--out file.xlsx]

Exit codes: 0 = sheet written, 1 = nothing to export / error.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import polib  # pip3 install --user --break-system-packages polib
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent
PO_DIR = ROOT / "src" / "i18n" / "po"

HEADERS = [
    "Key (msgid) — do not edit",
    "Context",
    "Form",
    "English",
    "English (plural)",
    "German (reference)",
    "German (plural)",
    "Suggestion (machine)",
    "Suggestion (machine, plural)",
    "YOUR TRANSLATION / Deine Übersetzung",
    "YOUR TRANSLATION (plural) / Deine Übersetzung (Mehrzahl)",
]

FILL_FILL = PatternFill("solid", fgColor="FFF2CC")  # light yellow
HEADER_FONT = Font(bold=True)
WRAP = Alignment(wrap_text=True, vertical="top")


def load_de_reference() -> dict[tuple[str | None, str], polib.POEntry]:
    """Map (msgctxt, msgid) → de entry for the reference columns."""
    de_path = PO_DIR / "de.po"
    if not de_path.exists():
        return {}
    de = polib.pofile(str(de_path), wrap_width=79)
    return {(e.msgctxt, e.msgid): e for e in de if not e.obsolete}


def bootstrap_po_if_missing(lang: str) -> tuple[polib.POFile, bool]:
    """Load the target po, creating it from the pot when missing."""
    po_path = PO_DIR / f"{lang}.po"
    if po_path.exists():
        return polib.pofile(str(po_path), wrap_width=79), False
    pot_path = PO_DIR / "messages.pot"
    if not pot_path.exists():
        raise SystemExit(f"neither {po_path.name} nor messages.pot found")
    po = polib.pofile(str(pot_path), wrap_width=79)
    po.metadata["Language"] = lang
    po.save(str(po_path))
    return po, True


def entry_text(entry: polib.POEntry) -> str:
    return (entry.msgstr or "").strip()


def plural_texts(entry: polib.POEntry) -> tuple[str, str]:
    forms = entry.msgstr_plural or {}
    return (forms.get(0, "") or "").strip(), (forms.get(1, "") or "").strip()


def needs_work(entry: polib.POEntry) -> bool:
    if "fuzzy" in entry.flags:
        return True
    if entry.msgid_plural:
        sg, pl = plural_texts(entry)
        return not (sg and pl)
    return entry_text(entry) == ""


def write_sheet(
    out_path: Path,
    lang: str,
    rows: list[dict[str, str]],
) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = f"NoorNote {lang}"

    ws.append(HEADERS)
    for cell in ws[1]:
        cell.font = HEADER_FONT
        cell.alignment = WRAP

    fill_cols = ("J", "K")
    for col in fill_cols:
        ws[f"{col}1"].fill = FILL_FILL

    for row in rows:
        ws.append([row[col] for col in "ABCDEFGHIJK"])

    for col, width in (
        ("A", 34),
        ("B", 16),
        ("C", 10),
        ("D", 42),
        ("E", 42),
        ("F", 42),
        ("G", 42),
        ("H", 42),
        ("I", 42),
        ("J", 46),
        ("K", 46),
    ):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "C2"

    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = WRAP
        for col in fill_cols:
            ws[f"{col}{cell.row}"].fill = FILL_FILL

    wb.save(out_path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True, help="target language code (e.g. ar)")
    ap.add_argument("--all", action="store_true", help="include final translations too")
    ap.add_argument("--out", default=None, help="output path (default: ./noornote-translate-<lang>.xlsx)")
    args = ap.parse_args()

    if args.lang == "en":
        print("en is the source catalog (msgid IS English) — nothing to export")
        return 1

    po, bootstrapped = bootstrap_po_if_missing(args.lang)
    de_ref = load_de_reference()

    rows: list[dict[str, str]] = []
    skipped_final = 0
    for entry in po:
        if entry.obsolete:
            continue
        final = not needs_work(entry)
        if final and not args.all:
            skipped_final += 1
            continue
        is_plural = bool(entry.msgid_plural)
        de_entry = de_ref.get((entry.msgctxt, entry.msgid))
        sg_de, pl_de = plural_texts(de_entry) if de_entry else ("", "")
        sg_mt, pl_mt = plural_texts(entry) if "fuzzy" in entry.flags else ("", "")
        rows.append(
            {
                "A": entry.msgid,
                "B": entry.msgctxt or "",
                "C": "Plural" if is_plural else "Singular",
                "D": entry.msgid,
                "E": entry.msgid_plural or "",
                "F": sg_de,
                "G": pl_de,
                "H": sg_mt,
                "I": pl_mt,
                "J": "",
                "K": "",
            }
        )

    if not rows:
        print(f"nothing to export for '{args.lang}' — catalog is fully translated"
              f"{' (use --all to export everything)' if not args.all else ''}")
        return 1

    out_path = Path(args.out or f"noornote-translate-{args.lang}.xlsx")
    write_sheet(out_path, args.lang, rows)

    plural_count = sum(1 for r in rows if r["C"] == "Plural")
    print(f"exported: {len(rows)} rows ({len(rows) - plural_count} singular, {plural_count} plural)")
    if bootstrapped:
        print(f"bootstrapped new catalog: src/i18n/po/{args.lang}.po (from pot)")
    if skipped_final:
        print(f"skipped already-final entries: {skipped_final} (--all to include)")
    print(f"file: {out_path}")
    print(f"next: send to translator, then import with tools/i18n-sheet-import.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
