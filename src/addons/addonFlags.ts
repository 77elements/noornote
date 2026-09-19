/**
 * Addon enabled-state lookup for UI consumers (the /addons overview LED etc.).
 *
 * Aggregates ONLY the cheap flag accessors from every addon's index.ts (each
 * reads PerAccountLocalStorage + a flat fallback — no heavy imports, see the
 * /addons skill "index.ts template"). Safe to import statically from anywhere.
 * Registry ids: src/addons/registry.ts. Read fresh on every call — the value
 * reflects the current account and the latest toggle.
 */

import { isAnalyticsEnabled } from './analytics/index';
import { isBadgesEnabled } from './badges/index';
import { isBookmarksEnabled } from './bookmarks/index';
import { isBtcPriceEnabled } from './btc-price/index';
import { isBulkDeleteEnabled } from './bulk-delete/index';
import { isCalendarEnabled } from './calendar/index';
import { isContentWordFilterEnabled } from './content-word-filter/index';
import { isCustomEmojisEnabled } from './custom-emojis/index';
import { isExtendedFollowsEnabled } from './extended-follows/index';
import { isFollowPacksEnabled } from './follow-packs/index';
import { isFollowerNotificationEnabled } from './follower-notification/index';
import { isGroupChatsEnabled } from './group-chats/index';
import { isHashtagSubscriptionsEnabled } from './hashtag-subscriptions/index';
import { isListSettingsEnabled } from './list-settings/index';
import { isLiveStreamsPlayerEnabled } from './live-streams-player/index';
import { isMarketplaceEnabled } from './marketplace/index';
import { isNostrMajlisEnabled } from './nostr-majlis/index';
import { isNoteTakingEnabled } from './note-taking/index';
import { isProfileRecognitionEnabled } from './profile-recognition/index';
import { isScheduledPostsEnabled } from './scheduled-posts/index';
import { isTribesEnabled } from './tribes/index';
import { isWalletBalanceEnabled } from './wallet-balance/index';

export function getAddonEnabled(id: string): boolean {
  switch (id) {
    case 'analytics':
      return isAnalyticsEnabled();
    case 'badges':
      return isBadgesEnabled();
    case 'bookmarks':
      return isBookmarksEnabled();
    case 'btc-price':
      return isBtcPriceEnabled();
    case 'bulk-delete':
      return isBulkDeleteEnabled();
    case 'calendar':
      return isCalendarEnabled();
    case 'wordfilter':
      return isContentWordFilterEnabled();
    case 'custom-emojis':
      return isCustomEmojisEnabled();
    case 'extended-follows':
      return isExtendedFollowsEnabled();
    case 'follow-packs':
      return isFollowPacksEnabled();
    case 'follower-notification':
      return isFollowerNotificationEnabled();
    case 'group-chats':
      return isGroupChatsEnabled();
    case 'hashtag-subscriptions':
      return isHashtagSubscriptionsEnabled();
    case 'list-settings':
      return isListSettingsEnabled();
    case 'live-streams-player':
      return isLiveStreamsPlayerEnabled();
    case 'marketplace':
      return isMarketplaceEnabled();
    case 'nostr-majlis':
      return isNostrMajlisEnabled();
    case 'note-taking':
      return isNoteTakingEnabled();
    case 'profile-recognition':
      return isProfileRecognitionEnabled();
    case 'scheduled-posts':
      return isScheduledPostsEnabled();
    case 'tribes':
      return isTribesEnabled();
    case 'wallet-balance':
      return isWalletBalanceEnabled();
    default:
      // Unknown registry id (future addon without an accessor yet) — show it
      // as active rather than wrongly red.
      return true;
  }
}
