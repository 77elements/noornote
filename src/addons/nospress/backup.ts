/**
 * NosPress local-backup — full per-account snapshot to a downloadable
 * ZIP file + restore from same. Final defence layer against data loss
 * (Relay outage, browser data wipe, account lock-out, future bug
 * classes we haven't seen yet).
 *
 * Bundle contents = every NosPress-related localStorage slot for the
 * current pubkey: drafts, published mirrors, page-index, menus,
 * site-settings, addon-enabled flag, plus legacy slots so an old data
 * shape isn't silently dropped during restore.
 *
 * Storage shape: each `StorageKeys.NOSPRESS_*` is a Map
 * `{ [pubkey]: value }` in localStorage. We read each map, pick the
 * current-user slot, copy into a `data` sub-object on the bundle. On
 * restore we walk the same set and write each slot back to its map.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { PerAccountLocalStorage, StorageKeys, type StorageKey } from '../../services/PerAccountLocalStorage';
import { EventBus } from '../../services/EventBus';

/** Storage keys included in every backup. Order is the canonical
 *  reading + writing order (no functional impact, just consistency in
 *  the resulting JSON for diff-ability). */
const BACKUP_KEYS: StorageKey[] = [
  StorageKeys.NOSPRESS_ENABLED,
  StorageKeys.NOSPRESS_DRAFTS_BY_SLUG,
  StorageKeys.NOSPRESS_PUBLISHED_BY_SLUG,
  StorageKeys.NOSPRESS_PAGE_INDEX,
  StorageKeys.NOSPRESS_MENUS,
  StorageKeys.NOSPRESS_SITE_SETTINGS,
  // Legacy slots — kept so restoring an older backup doesn't drop them.
  StorageKeys.NOSPRESS_DRAFT_V2,
  StorageKeys.NOSPRESS_PUBLISHED_V2,
  StorageKeys.NOSPRESS_LIST,
  StorageKeys.NOSPRESS_MOUNTS,
  StorageKeys.PROFILE_MOUNTS,
];

export interface NospressBackupBundle {
  version: 1;
  exportedAt: string;        // ISO timestamp
  pubkey: string;            // hex — for sanity-check on restore
  data: Record<string, unknown>;  // key = StorageKey value (raw localStorage key)
}

/** Assemble the in-memory bundle. Pure read — no side-effects. */
export function buildBackupBundle(pubkey: string): NospressBackupBundle {
  const perAccount = PerAccountLocalStorage.getInstance();
  const data: Record<string, unknown> = {};
  for (const key of BACKUP_KEYS) {
    const value = perAccount.getForPubkey<unknown>(key, pubkey, null);
    if (value !== null && value !== undefined) data[key] = value;
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    pubkey,
    data,
  };
}

/** Pack the bundle as a single-file ZIP and trigger a browser
 *  download. Filename = `nospress-backup-<short-pubkey>-<date>.zip`. */
export function downloadBackupZip(bundle: NospressBackupBundle): void {
  const json = JSON.stringify(bundle, null, 2);
  const zipped = zipSync({ 'nospress-backup.json': strToU8(json) });
  // TS strictness — Uint8Array<ArrayBufferLike> isn't a valid BlobPart
  // by structural typing. Cast through the underlying buffer to
  // satisfy the type checker; the runtime value is unchanged.
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const date = bundle.exportedAt.slice(0, 10);  // YYYY-MM-DD
  const shortPubkey = bundle.pubkey.slice(0, 12);
  const filename = `nospress-backup-${shortPubkey}-${date}.zip`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke the URL on the next tick so the browser has time to finish
  // the download stream.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a user-picked file, unzip it, parse + validate the bundle.
 *  Throws Error with a user-friendly message on any failure. */
export async function readBackupZip(file: File): Promise<NospressBackupBundle> {
  const buf = await file.arrayBuffer();
  let unzipped: ReturnType<typeof unzipSync>;
  try {
    unzipped = unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error('File is not a valid ZIP archive.');
  }
  const entry = unzipped['nospress-backup.json'];
  if (!entry) throw new Error('ZIP does not contain a NosPress backup.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(entry));
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }
  if (!isBundle(parsed)) throw new Error('Backup file shape is unrecognized.');
  return parsed;
}

function isBundle(v: unknown): v is NospressBackupBundle {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj.version === 1
    && typeof obj.pubkey === 'string'
    && typeof obj.exportedAt === 'string'
    && typeof obj.data === 'object' && obj.data !== null;
}

/** Write every slot in the bundle back to the pubkey's localStorage
 *  slots. Pubkey is enforced — if the bundle was exported by a
 *  different account, the caller decides whether to allow that
 *  (cross-account import) or refuse. Emits the refresh events the
 *  NosPress UI listens for, so the editor re-renders against fresh
 *  data without a full page reload. */
export function applyBackupBundle(bundle: NospressBackupBundle, pubkey: string): void {
  const perAccount = PerAccountLocalStorage.getInstance();
  for (const key of BACKUP_KEYS) {
    const value = bundle.data[key];
    if (value === undefined) continue;
    perAccount.setForPubkey(key, pubkey, value);
  }
  // Tell the editor + services to re-read. Match what the AutoSync
  // path emits after a relay sync — same UI refresh shape.
  const bus = EventBus.getInstance();
  bus.emit('nospressDraftV2:changed', { page: null, slug: '' });
  bus.emit('nospressPageIndex:changed', null);
  bus.emit('nospressMenus:changed', null);
  bus.emit('nospressSiteSettings:changed', null);
}
