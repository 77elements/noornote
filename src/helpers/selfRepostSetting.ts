/**
 * Self-repost visibility setting.
 *
 * A "self-repost" is a kind:6/16 repost whose author (the reposter) is the same
 * as the author of the reposted note — a user boosting their own post, often
 * hours or days later for extra exposure. When enabled, these are dropped from
 * the timeline. Foreign reposts (boosting someone else's note) are unaffected.
 *
 * The gap threshold refines this: a self-repost is only hidden when the time
 * between the original note and the repost is BELOW the threshold (i.e. the
 * user reposted shortly after their own post). 'all' hides every self-repost
 * regardless of the gap.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

export type SelfRepostGap = '3d' | '1w' | '3mo' | '1y' | 'all';

const GAP_SECONDS: Record<SelfRepostGap, number> = {
  '3d': 3 * 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '3mo': 90 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  all: Infinity,
};

export function isHideSelfRepostsEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.HIDE_SELF_REPOSTS,
    false
  );
}

export function setHideSelfRepostsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.HIDE_SELF_REPOSTS,
    enabled
  );
}

export function getSelfRepostGap(): SelfRepostGap {
  const v = PerAccountLocalStorage.getInstance().get<SelfRepostGap>(
    StorageKeys.HIDE_SELF_REPOSTS_GAP,
    'all'
  );
  return v in GAP_SECONDS ? v : 'all';
}

export function setSelfRepostGap(gap: SelfRepostGap): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.HIDE_SELF_REPOSTS_GAP,
    gap
  );
}

/** Threshold in seconds (Infinity for 'all'). */
export function getSelfRepostGapSeconds(): number {
  return GAP_SECONDS[getSelfRepostGap()];
}
