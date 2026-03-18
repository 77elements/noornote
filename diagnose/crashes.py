#!/usr/bin/env python3
"""
Crash log analysis — searches across all tiers (root, week, archive).

Usage: python3 diagnose/crashes.py ~/.noornote/{npub}/logs/
       python3 diagnose/crashes.py ~/.noornote/{npub}/logs/ --days 14
"""

import gzip
import json
import sys
from collections import Counter, defaultdict
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


def find_crash_logs(logs_dir: Path) -> list[Path]:
    files = []
    for subdir in [logs_dir, logs_dir / 'week', logs_dir / 'archive']:
        if not subdir.is_dir():
            continue
        files.extend(sorted(subdir.glob('crashes-*')))
    return files


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 diagnose/crashes.py <logs_directory> [--days N]")
        sys.exit(1)

    logs_dir = Path(sys.argv[1])
    max_days = None
    if "--days" in sys.argv:
        idx = sys.argv.index("--days")
        if idx + 1 < len(sys.argv):
            max_days = int(sys.argv[idx + 1])

    files = find_crash_logs(logs_dir)
    if not files:
        print("No crash logs found.")
        sys.exit(0)

    entries = []
    for f in files:
        entries.extend(read_jsonl(f))

    if not entries:
        print("Crash logs are empty — no crashes recorded.")
        sys.exit(0)

    # Filter by date if --days specified
    if max_days:
        from datetime import datetime, timedelta
        cutoff = (datetime.utcnow() - timedelta(days=max_days)).isoformat()
        entries = [e for e in entries if e.get("ts", "") >= cutoff]
        if not entries:
            print(f"No crashes in the last {max_days} days.")
            sys.exit(0)

    # Group by type
    by_type = defaultdict(list)
    for e in entries:
        data = e.get("data", {}) or {}
        crash_type = data.get("type", "Unknown") if isinstance(data, dict) else "Unknown"
        by_type[crash_type].append(e)

    print(f"=== Crash Analysis ({len(entries)} entries from {len(files)} files) ===")
    print(f"    Range: {entries[0].get('ts', '?')} → {entries[-1].get('ts', '?')}\n")

    # By type
    print("--- By Type ---")
    for crash_type, items in sorted(by_type.items(), key=lambda x: -len(x[1])):
        print(f"  {len(items):4d}x  {crash_type}")

    # By day
    print("\n--- By Day ---")
    by_day = Counter()
    for e in entries:
        day = e.get("ts", "?")[:10]
        by_day[day] += 1
    for day, count in sorted(by_day.items()):
        print(f"  {day}  {count:4d} crashes")

    # Unique errors
    print("\n--- Unique Errors ---")
    error_msgs = Counter()
    for e in entries:
        data = e.get("data", {}) or {}
        error = data.get("error", e.get("msg", "?")) if isinstance(data, dict) else e.get("msg", "?")
        if len(error) > 120:
            error = error[:120] + "..."
        error_msgs[error] += 1
    for msg, count in error_msgs.most_common(20):
        print(f"  {count:4d}x  {msg}")

    # Last 10
    print(f"\n--- Last {min(10, len(entries))} Crashes ---")
    for e in entries[-10:]:
        ts = e.get("ts", "?")
        msg = e.get("msg", "?")
        data = e.get("data", {}) or {}
        context = data.get("context", "") if isinstance(data, dict) else ""
        stack_preview = ""
        if isinstance(data, dict) and data.get("stack"):
            stack_lines = data["stack"].split("\n")
            stack_preview = f"  @ {stack_lines[1].strip()}" if len(stack_lines) > 1 else ""

        print(f"\n  [{ts}]")
        print(f"  {msg}")
        if context:
            print(f"  Context: {context}")
        if stack_preview:
            print(f"  {stack_preview}")


if __name__ == "__main__":
    main()
