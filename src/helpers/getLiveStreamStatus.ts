import type { NostrEvent } from '@nostr-dev-kit/ndk';

/** Normalized NIP-53 live activity status. */
export type LiveStreamStatus = 'live' | 'planned' | 'ended';

/** NIP-53 empfehlung: "clients MAY consider status=live events after 1hr
 *  without any update as ended". */
const STALE_LIVE_AGE_SEC = 60 * 60;

/** A `planned` event whose `starts` is more than this far in the past should
 *  already have gone live — treat it as ended. */
const STALE_PLANNED_AFTER_START_SEC = 60 * 60;

/**
 * Resolve the *effective* status of a kind 30311 live activity, applying the
 * NIP-53-recommended staleness guards.
 *
 * - `live` events older than 1h without update → `ended`
 * - `planned` events whose `starts` is > 1h in the past → `ended`
 * - `planned` without `starts` → `planned`
 * - unknown / missing status → `planned`
 *
 * Used by every live-stream renderer so the staleness rule is applied
 * consistently (top-level 30311, reposts, quotes, SNV, bookmarks).
 */
export function getLiveStreamStatus(event: NostrEvent, nowSec: number = Math.floor(Date.now() / 1000)): LiveStreamStatus {
  const raw = event.tags.find(t => t[0] === 'status')?.[1]?.toLowerCase().trim();

  if (raw === 'live') {
    const ageSec = nowSec - (event.created_at ?? 0);
    if (ageSec > STALE_LIVE_AGE_SEC) return 'ended';
    return 'live';
  }

  if (raw === 'ended') {
    return 'ended';
  }

  // raw === 'planned' or unknown / missing
  const startsRaw = event.tags.find(t => t[0] === 'starts')?.[1];
  if (startsRaw) {
    const starts = Number(startsRaw);
    if (Number.isFinite(starts) && starts > 0 && (nowSec - starts) > STALE_PLANNED_AFTER_START_SEC) {
      return 'ended';
    }
  }

  return 'planned';
}
