/**
 * registerCoreAddons — wires all bundled addons into the AddonLoader.
 *
 * Called once from App.ts during initialization, BEFORE AddonLoader.bootstrap().
 * Registration is cheap: it stores a `load:` factory (a dynamic `import()`
 * closure) and subscribes to the `<id>:addon-toggle` event. The heavy addon
 * module is not loaded until the flag is verified ON.
 *
 * Bookmarks and Tribes are intentionally NOT registered here. They remain
 * UI-gated through the existing flag-import pattern to avoid touching the
 * lists sync architecture (see docs/todos/addons-true-lazy-loading.md).
 */

import { AddonLoader } from './AddonLoader';
import { isWalletBalanceEnabled } from './wallet-balance/index';
import { isBtcPriceEnabled } from './btc-price/index';
import { isProfileRecognitionEnabled } from './profile-recognition/index';
import { isLiveStreamsEnabled } from './live-streams/index';
import { isHashtagSubscriptionsEnabled } from './hashtag-subscriptions/index';
import {
  isContentWordFilterEnabled,
  isWordFilterAutoLoaded,
} from './content-word-filter/index';
import { isCustomEmojisEnabled } from './custom-emojis/index';
import { isMarketplaceEnabled } from './marketplace/index';
import { isFollowPacksEnabled } from './follow-packs/index';
import { isFollowerNotificationEnabled } from './follower-notification/index';
import { isFeedbackBoardEnabled } from './feedback-board/index';
import { isScheduledPostsEnabled } from './scheduled-posts/index';
import { isBadgesEnabled } from './badges/index';
import {
  isNoteTakingEnabled,
  isNoteTakingAutoLoaded,
} from './note-taking/index';
import { isBulkDeleteEnabled } from './bulk-delete/index';
import {
  isNostrMajlisEnabled,
  isNostrMajlisAutoLoaded,
} from './nostr-majlis/index';
import { isGroupChatsEnabled, isArmadaEnabled } from './group-chats/index';
import { isAnalyticsEnabled } from './analytics/index';
import { isCalendarEnabled } from './calendar/index';
import { isFocusUiEnabled } from '../helpers/focusUiSetting';

export function registerCoreAddons(): void {
  const loader = AddonLoader.getInstance();

  loader.register({
    id: 'wallet-balance',
    isEnabled: isWalletBalanceEnabled,
    load: () => import('./wallet-balance/runtime').then(m => m.default),
  });

  loader.register({
    id: 'btc-price',
    isEnabled: isBtcPriceEnabled,
    load: () => import('./btc-price/runtime').then(m => m.default),
  });

  loader.register({
    id: 'profile-recognition',
    isEnabled: isProfileRecognitionEnabled,
    load: () => import('./profile-recognition/runtime').then(m => m.default),
  });

  loader.register({
    id: 'live-streams',
    isEnabled: isLiveStreamsEnabled,
    // Always-on whenever the addon is enabled — the TV renders notes with
    // embedded live-stream players. The widget switch / a background pin
    // do NOT gate the runtime (see isLiveStreamsAutoLoaded for the
    // on-demand release guards).
    load: () => import('./live-streams/runtime').then(m => m.default),
  });

  loader.register({
    id: 'hashtag-subscriptions',
    isEnabled: isHashtagSubscriptionsEnabled,
    load: () => import('./hashtag-subscriptions/runtime').then(m => m.default),
  });

  loader.register({
    id: 'follower-notification',
    isEnabled: isFollowerNotificationEnabled,
    // Always-on whenever user-enabled — ON means the follower scan keeps
    // running while the object is closed (the switch is the preference).
    // v1 (no Focus UI): always governed by the switch alone.
    bootLoad: () => !isFocusUiEnabled() || isFollowerNotificationEnabled(),
    load: () => import('./follower-notification/runtime').then(m => m.default),
  });

  loader.register({
    id: 'feedback-board',
    isEnabled: isFeedbackBoardEnabled,
    load: () => import('./feedback-board/runtime').then(m => m.default),
  });

  // Note: registry id is 'wordfilter' (matches ADDON_REGISTRY and App.ts route)
  loader.register({
    id: 'wordfilter',
    isEnabled: isContentWordFilterEnabled,
    // Boot-load only with at least one word configured — that is the
    // addon's always-on reason (the filter must keep suppressing feed
    // posts). Without words it is pure on-demand (the FV object).
    bootLoad: () => isWordFilterAutoLoaded(),
    load: () => import('./content-word-filter/runtime').then(m => m.default),
  });

  loader.register({
    id: 'custom-emojis',
    isEnabled: isCustomEmojisEnabled,
    load: () => import('./custom-emojis/runtime').then(m => m.default),
  });

  loader.register({
    id: 'marketplace',
    isEnabled: isMarketplaceEnabled,
    load: () => import('./marketplace/runtime').then(m => m.default),
  });

  loader.register({
    id: 'follow-packs',
    isEnabled: isFollowPacksEnabled,
    load: () => import('./follow-packs/runtime').then(m => m.default),
  });

  loader.register({
    id: 'scheduled-posts',
    isEnabled: isScheduledPostsEnabled,
    load: () => import('./scheduled-posts/runtime').then(m => m.default),
  });

  loader.register({
    id: 'badges',
    isEnabled: isBadgesEnabled,
    load: () => import('./badges/runtime').then(m => m.default),
  });

  loader.register({
    id: 'note-taking',
    isEnabled: isNoteTakingEnabled,
    // Always-on while a note's reminder still lies in the future — the
    // reminder scheduler must stay alive to fire it (isNoteTakingAutoLoaded;
    // a past due time self-expires the reason). Otherwise pure on-demand.
    bootLoad: () => isNoteTakingAutoLoaded(),
    load: () => import('./note-taking/runtime').then(m => m.default),
  });

  loader.register({
    id: 'bulk-delete',
    isEnabled: isBulkDeleteEnabled,
    // Pure on-demand in the Focus UI: a tool has no always-on reason, and
    // entering the object IS enabling (no switch in v2).
    bootLoad: () => !isFocusUiEnabled(),
    load: () => import('./bulk-delete/runtime').then(m => m.default),
  });

  loader.register({
    id: 'nostr-majlis',
    isEnabled: isNostrMajlisEnabled,
    // On-demand in the Focus UI: loaded only when the object is entered
    // (or a widget is active — the always-on reasons, see
    // isNostrMajlisAutoLoaded). The v2 object releases it on leave.
    bootLoad: () => isNostrMajlisAutoLoaded(),
    load: () => import('./nostr-majlis/runtime').then(m => m.default),
  });

  loader.register({
    id: 'group-chats',
    isEnabled: isGroupChatsEnabled,
    // Always-on whenever Nostrord or Armada is user-enabled — ON means the
    // community polling keeps running while the object is closed.
    bootLoad: () =>
      !isFocusUiEnabled() || isGroupChatsEnabled() || isArmadaEnabled(),
    load: () => import('./group-chats/runtime').then(m => m.default),
  });

  loader.register({
    id: 'analytics',
    isEnabled: isAnalyticsEnabled,
    // Pure on-demand in the Focus UI: analytics is visit-driven (relay
    // sweeps only run while the user looks at the page — by design), and
    // entering the object IS enabling (no switch in v2).
    bootLoad: () => !isFocusUiEnabled(),
    load: () => import('./analytics/runtime').then(m => m.default),
  });

  loader.register({
    id: 'calendar',
    isEnabled: isCalendarEnabled,
    load: () => import('./calendar/runtime').then(m => m.default),
  });

  // Out of scope (list-adjacent, deferred — separate decision):
  //   list-settings, extended-follows, bookmarks, tribes
}
