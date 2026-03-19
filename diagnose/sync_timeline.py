#!/usr/bin/env python3
"""
Sync timeline — chronological sync operations across all tiers.

Usage: python3 diagnose/sync_timeline.py ~/.noornote/{npub}/logs/
       python3 diagnose/sync_timeline.py ~/.noornote/{npub}/logs/ --last 5
       python3 diagnose/sync_timeline.py ~/.noornote/{npub}/logs/ --days 3
"""

import gzip
import json
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


def find_list_logs(logs_dir: Path) -> list[Path]:
    files = []
    for subdir in [logs_dir / 'archive', logs_dir / 'week', logs_dir]:
        if not subdir.is_dir():
            continue
        files.extend(sorted(subdir.glob('lists-*')))
    return files


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 diagnose/sync_timeline.py <logs_directory> [--last N] [--days N]")
        sys.exit(1)

    logs_dir = Path(sys.argv[1])
    last_n = None
    max_days = None

    if "--last" in sys.argv:
        idx = sys.argv.index("--last")
        if idx + 1 < len(sys.argv):
            last_n = int(sys.argv[idx + 1])

    if "--days" in sys.argv:
        idx = sys.argv.index("--days")
        if idx + 1 < len(sys.argv):
            max_days = int(sys.argv[idx + 1])

    files = find_list_logs(logs_dir)
    if not files:
        print("No lists logs found.")
        sys.exit(0)

    # Read all entries, sorted by timestamp
    all_entries = []
    for f in files:
        all_entries.extend(read_jsonl(f))
    all_entries.sort(key=lambda e: e.get("ts", ""))

    if not all_entries:
        print("No entries found.")
        sys.exit(0)

    # Filter by date if --days specified
    if max_days:
        from datetime import datetime, timedelta
        cutoff = (datetime.utcnow() - timedelta(days=max_days)).isoformat()
        all_entries = [e for e in all_entries if e.get("ts", "") >= cutoff]

    # Filter to sync-relevant entries
    sync_markers = [
        "syncFromRelaysAll", "syncFromRelays(", "fetchAndCompare(",
        "timestamp compare", "relay is newer", "local is newer",
        "relay empty safety",
        "showSyncConfirmationModal", "SyncConfirmationModal",
        "Keep all", "Keep relay", "Keep local",
        "onKeep(", "onRelay(", "onLocal(",
        "fetchBookmarksFromRelays:", "fetchFromRelays",
        "publishToRelays", "publishBookmarksToRelays:",
        "applyRelayFolderOrder", "setListLastModified",
    ]

    sync_entries = [
        e for e in all_entries
        if any(marker in e.get("msg", "") for marker in sync_markers)
    ]

    if not sync_entries:
        print("No sync operations found in logs.")
        sys.exit(0)

    # Group into sync cycles
    cycles = []
    current_cycle = []
    for e in sync_entries:
        msg = e.get("msg", "")
        if "syncFromRelaysAll" in msg and "starting" in msg:
            if current_cycle:
                cycles.append(current_cycle)
            current_cycle = [e]
        else:
            current_cycle.append(e)
    if current_cycle:
        cycles.append(current_cycle)

    if last_n:
        cycles = cycles[-last_n:]

    print(f"=== Sync Timeline ({len(cycles)} cycles) ===\n")

    for i, cycle in enumerate(cycles):
        start_ts = cycle[0].get("ts", "?")
        end_ts = cycle[-1].get("ts", "?")
        print(f"--- Cycle {i + 1}: {start_ts} → {end_ts} ({len(cycle)} events) ---")

        for e in cycle:
            ts = e.get("ts", "?")[11:23]  # HH:MM:SS.mmm
            msg = e.get("msg", "?")
            data = e.get("data", {})

            detail = ""
            if isinstance(data, dict):
                if "items" in data and isinstance(data["items"], list):
                    detail = f" [{len(data['items'])} items]"
                elif "count" in data:
                    detail = f" [count={data['count']}]"
                elif "added" in data and "removed" in data:
                    added = data["added"] if isinstance(data["added"], list) else []
                    removed = data["removed"] if isinstance(data["removed"], list) else []
                    detail = f" [+{len(added)} -{len(removed)}]"
                elif "requiresConfirmation" in data:
                    detail = f" [confirm={data['requiresConfirmation']}]"

            print(f"  {ts}  {msg}{detail}")
        print()


if __name__ == "__main__":
    main()
