#!/usr/bin/env python3
"""
Diagnostic log overview — shows summary across all tiers (root, week, archive).

Usage: python3 diagnose/overview.py ~/.noornote/{npub}/logs/
"""

import gzip
import json
import sys
from collections import Counter
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
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    except Exception:
        pass
    return entries


def find_all_logs(logs_dir: Path) -> dict[str, list[Path]]:
    """Find all log files across root, week/, archive/ grouped by area."""
    areas: dict[str, list[Path]] = {}
    for subdir in [logs_dir, logs_dir / 'week', logs_dir / 'archive']:
        if not subdir.is_dir():
            continue
        for f in sorted(subdir.glob('*.jsonl*')):
            if not f.is_file():
                continue
            area = f.name.split('-')[0]
            areas.setdefault(area, []).append(f)
    return areas


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 diagnose/overview.py <logs_directory>")
        sys.exit(1)

    logs_dir = Path(sys.argv[1])
    if not logs_dir.is_dir():
        print(f"Not a directory: {logs_dir}")
        sys.exit(1)

    areas = find_all_logs(logs_dir)
    if not areas:
        print(f"No log files found in {logs_dir}")
        sys.exit(1)

    print(f"=== Diagnostic Logs: {logs_dir} ===\n")

    for area, files in sorted(areas.items()):
        root_files = [f for f in files if f.parent == logs_dir]
        week_files = [f for f in files if f.parent.name == 'week']
        archive_files = [f for f in files if f.parent.name == 'archive']

        all_entries = []
        for f in files:
            all_entries.extend(read_jsonl(f))

        print(f"--- {area} ---")
        if not all_entries:
            print("  (empty)\n")
            continue

        total_size = sum(f.stat().st_size for f in files)
        timestamps = [e.get("ts", "") for e in all_entries]
        messages = Counter(e.get("msg", "(no msg)") for e in all_entries)

        print(f"  Total entries: {len(all_entries)}  ({len(messages)} unique messages)")
        print(f"  Total size:    {total_size / 1024:.1f} KB across {len(files)} files")
        print(f"  Range:         {timestamps[0]}  →  {timestamps[-1]}")
        print(f"  Files:         {len(root_files)} today, {len(week_files)} in week/, {len(archive_files)} in archive/")
        print(f"  Top messages:")
        for msg, count in messages.most_common(10):
            print(f"    {count:4d}x  {msg}")
        print()


if __name__ == "__main__":
    main()
