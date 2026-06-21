/**
 * Shared cross-device folder-deletion record (NIP-78 kind:30078).
 * ---------------------------------------------------------------
 * One implementation, used by BOTH bookmarks and tribes (DRY) so the two lists
 * behave identically. Extracted verbatim from the bookmarks solution that has
 * been holding since 2026-06-04 (commit 753b71dd) — see docs/features/lists.md
 * "Resurrection-Comeback ... (2026-06-04)".
 *
 * The per-list local tombstone map (BOOKMARK_TOMBSTONES / TRIBE_TOMBSTONES) is
 * per-device and lost on reinstall. To make "deleted stays deleted" work across
 * all of the user's devices WITHOUT relying on NIP-09 kind:5 (which relays
 * garbage-collect — the root cause of resurrection), each list keeps a single
 * durable replaceable event recording, per folder name, the latest intent:
 * deleted (d:true) or revived (d:false) plus a timestamp. It is ordinary
 * app-data, not a deletion marker, so relays keep it like any replaceable event.
 *
 * Content is plaintext JSON: { v:1, entries: { "<name>": { t:<sec>, d:<bool> } } }.
 * Resolution is last-write-wins per name (max t). The local map mirrors this on
 * every fetch (syncDeletionsIntoLocal); all existing per-list tombstone filters
 * then work cross-device unchanged.
 *
 * A caller wires this to its list by supplying the d-tag and the accessors for
 * its own local tombstone map. Nothing list-specific lives here.
 */

import { fetchEvents, publishEvent, signEvent, getCurrentUserPubkey } from './relays';
import { now } from './storage';
import { diagLog } from '../services/DiagnosticLogger';

export interface DeletionRecordConfig {
  /** kind:30078 d-tag, e.g. 'noornote:bookmark-deletions' / 'noornote:tribe-deletions'. */
  dTag: string;
  /** Human label for the event's 'alt' tag. */
  alt: string;
  /** diagLog message prefix, e.g. 'bookmark-deletions' / 'tribe-deletions'. */
  logLabel: string;
  /** Read the list's local tombstone map ({ name: deletionTsSec }). */
  getLocalTombstones: () => Record<string, number>;
  /** Persist the list's local tombstone map. */
  setLocalTombstones: (map: Record<string, number>) => void;
}

interface SharedDeletionEntry { t: number; d: boolean; }

const DELETION_MAX_AGE_SEC = 365 * 24 * 60 * 60; // prune entries older than 1 year

async function fetchDeletionEntries(cfg: DeletionRecordConfig, pubkey: string): Promise<Record<string, SharedDeletionEntry>> {
  const events = await fetchEvents([{
    authors: [pubkey],
    kinds: [30078],
    '#d': [cfg.dTag]
  }], 5000, true);
  if (events.length === 0) return {};
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!newest?.content) return {};
  try {
    const parsed = JSON.parse(newest.content) as { entries?: Record<string, unknown> };
    if (!parsed.entries || typeof parsed.entries !== 'object') return {};
    const out: Record<string, SharedDeletionEntry> = {};
    for (const [name, raw] of Object.entries(parsed.entries)) {
      const entry = raw as { t?: unknown; d?: unknown };
      if (typeof entry?.t === 'number') out[name] = { t: entry.t, d: entry.d === true };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Publish the shared deletion record. Union-on-publish: merges the relay's current
 * entries with every locally-tombstoned name (as a deletion) so a stale device never
 * drops another device's deletion. The explicit `change` (delete/revive) wins with a
 * fresh timestamp. Does NOT mutate the local map — callers already did that.
 */
export async function publishDeletions(
  cfg: DeletionRecordConfig,
  pubkey: string,
  change?: { name: string; deleted: boolean }
): Promise<void> {
  const nowSec = now();
  const relayEntries = await fetchDeletionEntries(cfg, pubkey);
  const merged: Record<string, SharedDeletionEntry> = { ...relayEntries };

  const localTombstones = cfg.getLocalTombstones();
  for (const [name, ts] of Object.entries(localTombstones)) {
    // Don't override a newer revival the relay already knows about.
    if (!merged[name] || merged[name].t <= ts) merged[name] = { t: ts, d: true };
  }

  if (change?.name) merged[change.name] = { t: nowSec, d: change.deleted };

  for (const [name, entry] of Object.entries(merged)) {
    if (nowSec - entry.t > DELETION_MAX_AGE_SEC) delete merged[name];
  }

  const signed = await signEvent({
    kind: 30078,
    created_at: nowSec,
    tags: [['d', cfg.dTag], ['alt', cfg.alt]],
    content: JSON.stringify({ v: 1, entries: merged }),
    pubkey
  });
  if (signed) {
    await publishEvent(signed);
    diagLog('lists', `${cfg.logLabel}: published`, { change, entryCount: Object.keys(merged).length });
  }
}

/** Fire-and-forget wrapper used from the local tombstone add/remove hooks. */
export function publishDeletionChange(cfg: DeletionRecordConfig, folderName: string, deleted: boolean): void {
  const pubkey = getCurrentUserPubkey();
  if (!pubkey) return;
  void publishDeletions(cfg, pubkey, { name: folderName, deleted }).catch(err => {
    diagLog('lists', `${cfg.logLabel}: publish change FAILED`, { folderName, deleted, error: String(err) });
  });
}

/**
 * Pull the shared deletion record into the local tombstone map. Deletions from any
 * device add a local tombstone; revivals newer than our local deletion clear it.
 * Run inside the list's relay-fetch path before its tombstone filter, so every
 * relay-read path honours cross-device deletions. Prunes entries older than 1 year.
 */
export async function syncDeletionsIntoLocal(cfg: DeletionRecordConfig, pubkey: string): Promise<void> {
  const relayEntries = await fetchDeletionEntries(cfg, pubkey);
  const local = cfg.getLocalTombstones();
  const nowSec = now();
  let changed = false;

  for (const [name, entry] of Object.entries(relayEntries)) {
    if (entry.d) {
      if (local[name] === undefined || local[name] < entry.t) { local[name] = entry.t; changed = true; }
    } else {
      if (local[name] !== undefined && entry.t >= local[name]) { delete local[name]; changed = true; }
    }
  }

  for (const [name, ts] of Object.entries(local)) {
    if (nowSec - ts > DELETION_MAX_AGE_SEC) { delete local[name]; changed = true; }
  }

  if (changed) {
    cfg.setLocalTombstones(local);
    diagLog('lists', `${cfg.logLabel}: synced into local`, {
      relayEntryCount: Object.keys(relayEntries).length,
      localTombstoneCount: Object.keys(local).length
    });
  }
}
