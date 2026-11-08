/**
 * nip40.ts - NIP-40 expiration helpers
 *
 * An event with an `expiration` tag (unix timestamp in seconds) should not
 * be served anymore once that point passes. Per NIP-11-check: relays only
 * PROMISE to stop serving — they may keep the data, so this is NOT a
 * deletion or privacy guarantee.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

/** Exported for tests. */
export const EXPIRATION_TAG = 'expiration';

/**
 * Read the NIP-40 `expiration` tag of an event, or null when absent/invalid.
 */
export function getEventExpiration(event: NostrEvent): number | null {
  const tag = event.tags?.find(t => t[0] === EXPIRATION_TAG);
  if (!tag?.[1]) return null;
  const ts = Number(tag[1]);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
}

/**
 * Whether the event carries an `expiration` tag that has already passed.
 * Valid-past events (no tag / not yet expired) are never expired.
 */
export function isExpiredEvent(event: NostrEvent): boolean {
  const expiration = getEventExpiration(event);
  if (expiration === null) return false;
  return expiration <= Math.floor(Date.now() / 1000);
}

/** Predefined lifetimes offered in the composer, in seconds. */
export const EXPIRY_CHOICES: { seconds: number; labelKey: string }[] = [
  { seconds: 3600, labelKey: '1 hour' },
  { seconds: 86400, labelKey: '1 day' },
  { seconds: 604800, labelKey: '1 week' },
];

/**
 * UI setting: show the small "Post expires on …" line under expiring notes.
 * Default OFF (user opt-in via Settings → UI).
 */
export function isExpiryNoticeEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.SHOW_EXPIRY_NOTICE,
    false
  );
}

export function setExpiryNoticeEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.SHOW_EXPIRY_NOTICE,
    enabled
  );
}
