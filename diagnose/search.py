#!/usr/bin/env python3
"""
Search across all log files (root, week, archive) for a pattern.

Usage: python3 diagnose/search.py ~/.noornote/{npub}/logs/ "DECRYPT FAILED"
       python3 diagnose/search.py ~/.noornote/{npub}/logs/ "DECRYPT FAILED" --area crashes
       python3 diagnose/search.py ~/.noornote/{npub}/logs/ "DECRYPT FAILED" --days 14
"""

import gzip
import json
import re
import sys
from pathlib import Path


def read_jsonl(filepath: Path) -> list[dict]:
    entries = []
    try:
        if filepath.suffix == '.gz':
            text = gzip.open(filepath, 'rt', encoding='utf-8').read()
        else:
            text = filepath.read_text()
        for line in text.splitlines():
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except Exception:
        pass
    return entries


def find_logs(logs_dir: Path, area_filter: str | None = None) -> list[Path]:
    files = []
    for subdir in [logs_dir / 'archive', logs_dir / 'week', logs_dir]:
        if not subdir.is_dir():
            continue
        pattern = f'{area_filter}-*' if area_filter else '*'
        for ext in ['.jsonl', '.jsonl.gz']:
            files.extend(sorted(subdir.glob(f'{pattern}{ext}')))
    return files


def matches(entry: dict, pattern: re.Pattern) -> bool:
    """Check if pattern matches msg or any string value in data."""
    if pattern.search(entry.get("msg", "")):
        return True
    data = entry.get("data")
    if data is not None:
        data_str = json.dumps(data) if not isinstance(data, str) else data
        if pattern.search(data_str):
            return True
    return False


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 diagnose/search.py <logs_directory> <pattern> [--area NAME] [--days N]")
        sys.exit(1)

    logs_dir = Path(sys.argv[1])
    search_pattern = sys.argv[2]
    area_filter = None
    max_days = None

    args = sys.argv[3:]
    i = 0
    while i < len(args):
        if args[i] == "--area" and i + 1 < len(args):
            area_filter = args[i + 1]
            i += 2
        elif args[i] == "--days" and i + 1 < len(args):
            max_days = int(args[i + 1])
            i += 2
        else:
            i += 1

    pattern = re.compile(search_pattern, re.IGNORECASE)
    files = find_logs(logs_dir, area_filter)

    if not files:
        print("No log files found.")
        sys.exit(0)

    # Filter by date if --days specified
    cutoff = None
    if max_days:
        from datetime import datetime, timedelta
        cutoff = (datetime.utcnow() - timedelta(days=max_days)).isoformat()

    total_matches = 0
    matches_by_day: dict[str, list[dict]] = {}

    for f in files:
        entries = read_jsonl(f)
        for e in entries:
            if cutoff and e.get("ts", "") < cutoff:
                continue
            if matches(e, pattern):
                total_matches += 1
                day = e.get("ts", "?")[:10]
                matches_by_day.setdefault(day, []).append(e)

    if total_matches == 0:
        scope = f"(searched {len(files)} files"
        if area_filter:
            scope += f", area={area_filter}"
        if max_days:
            scope += f", last {max_days} days"
        scope += ")"
        print(f'No matches for "{search_pattern}" {scope}')
        sys.exit(0)

    print(f'=== Search: "{search_pattern}" — {total_matches} matches across {len(matches_by_day)} days ===\n')

    for day, day_entries in sorted(matches_by_day.items()):
        print(f"--- {day} ({len(day_entries)} matches) ---")
        for e in day_entries:
            ts = e.get("ts", "?")[11:23]
            area = e.get("area", "?")
            msg = e.get("msg", "?")
            data = e.get("data", {})

            data_preview = ""
            if isinstance(data, dict):
                # Show compact relevant fields
                relevant = {k: v for k, v in data.items()
                           if isinstance(v, (str, int, float, bool)) and pattern.search(str(v))}
                if relevant:
                    data_preview = f"  {relevant}"

            print(f"  {ts} [{area}] {msg}{data_preview}")
        print()


if __name__ == "__main__":
    main()
