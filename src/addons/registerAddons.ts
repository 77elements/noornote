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

export function registerCoreAddons(): void {
  const loader = AddonLoader.getInstance();

  loader.register({
    id: 'wallet-balance',
    isEnabled: isWalletBalanceEnabled,
    load: () => import('./wallet-balance/runtime').then(m => m.default),
  });

  // Phase 3+ will add:
  //   profile-recognition, live-streams-player, hashtag-subscriptions,
  //   word-filter, list-settings, extended-follows, nostrin, custom-emojis,
  //   marketplace, follow-packs
}
