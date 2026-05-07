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
import { isProfileRecognitionEnabled } from './profile-recognition/index';
import { isLiveStreamsPlayerEnabled } from './live-streams-player/index';
import { isHashtagSubscriptionsEnabled } from './hashtag-subscriptions/index';
import { isContentWordFilterEnabled } from './content-word-filter/index';
import { isCustomEmojisEnabled } from './custom-emojis/index';
import { isMarketplaceEnabled } from './marketplace/index';
import { isFollowPacksEnabled } from './follow-packs/index';
import { isScheduledPostsEnabled } from './scheduled-posts/index';
import { isNospressEnabled } from './nospress/index';

export function registerCoreAddons(): void {
  const loader = AddonLoader.getInstance();

  loader.register({
    id: 'wallet-balance',
    isEnabled: isWalletBalanceEnabled,
    load: () => import('./wallet-balance/runtime').then(m => m.default),
  });

  loader.register({
    id: 'profile-recognition',
    isEnabled: isProfileRecognitionEnabled,
    load: () => import('./profile-recognition/runtime').then(m => m.default),
  });

  loader.register({
    id: 'live-streams-player',
    isEnabled: isLiveStreamsPlayerEnabled,
    load: () => import('./live-streams-player/runtime').then(m => m.default),
  });

  loader.register({
    id: 'hashtag-subscriptions',
    isEnabled: isHashtagSubscriptionsEnabled,
    load: () => import('./hashtag-subscriptions/runtime').then(m => m.default),
  });

  // Note: registry id is 'wordfilter' (matches ADDON_REGISTRY and App.ts route)
  loader.register({
    id: 'wordfilter',
    isEnabled: isContentWordFilterEnabled,
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
    id: 'nospress',
    isEnabled: isNospressEnabled,
    load: () => import('./nospress/runtime').then(m => m.default),
  });

  // Out of scope (list-adjacent, deferred — separate decision):
  //   list-settings, extended-follows, bookmarks, tribes
}
