/**
 * Self-repost visibility setting.
 *
 * A "self-repost" is a kind:6/16 repost whose author (the reposter) is the same
 * as the author of the reposted note — a user boosting their own post, often
 * hours or days later for extra exposure. When enabled, these are dropped from
 * the timeline. Foreign reposts (boosting someone else's note) are unaffected.
 */

import { PerAccountLocalStorage, StorageKeys } from '../services/PerAccountLocalStorage';

export function isHideSelfRepostsEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.HIDE_SELF_REPOSTS, false);
}

export function setHideSelfRepostsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.HIDE_SELF_REPOSTS, enabled);
}
