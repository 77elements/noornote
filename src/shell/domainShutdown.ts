/**
 * Hidden-domain shutdown (v2) — the RAM principle applied to hidden
 * objects (docs/todos/hidden-objects.md, Phase 4).
 *
 * Hiding an addon-backed domain must not just remove the circle: the
 * addon's machinery (background polling, relay subscriptions, runtime
 * memory) is switched OFF entirely — the same code path the classic
 * Settings toggle uses, so every gate (ISL icons, NoteMenu entries,
 * widget availability) reacts identically. Unhide reverses it: the addon
 * is re-enabled and reloads lazily.
 *
 * Domain → addon mapping (ids where they differ): majlis → nostr-majlis,
 * word-filter → wordfilter. List-backed domains (muted, bookmarks,
 * tribes) have no addon toggle — their sync machinery is user-triggered
 * only and stays untouched (src/lists field test, docs/features/lists.md).
 */

import { TypedEventBus } from '../core/TypedEventBus';
import type { AppEventName } from '../core/events';
import { ModuleLoader } from '../core/ModuleLoader';
import { HIDDEN_ADDON_DOMAINS } from './hiddenAddonDomains';
import { diagLog } from '../services/DiagnosticLogger';
import type { DMsModuleApi } from '../modules/dms/contracts';
import type { NotificationsModuleApi } from '../modules/notifications/contracts';
import { setAnalyticsEnabled } from '../addons/analytics/index';
import { setBadgesEnabled } from '../addons/badges/index';
import { setBulkDeleteEnabled } from '../addons/bulk-delete/index';
import { setCalendarEnabled } from '../addons/calendar/index';
import { setContentWordFilterEnabled } from '../addons/content-word-filter/index';
import { setCustomEmojisEnabled } from '../addons/custom-emojis/index';
import { setFeedbackBoardEnabled } from '../addons/feedback-board/index';
import { setFollowPacksEnabled } from '../addons/follow-packs/index';
import { setFollowerNotificationEnabled } from '../addons/follower-notification/index';
import { setGroupChatsEnabled } from '../addons/group-chats/index';
import { setHashtagSubscriptionsEnabled } from '../addons/hashtag-subscriptions/index';
import { setLiveStreamsEnabled } from '../addons/live-streams/index';
import { setMarketplaceEnabled } from '../addons/marketplace/index';
import { setNostrMajlisEnabled } from '../addons/nostr-majlis/index';
import { setNoteTakingEnabled } from '../addons/note-taking/index';
import { setScheduledPostsEnabled } from '../addons/scheduled-posts/index';
import { setWalletBalanceEnabled } from '../addons/wallet-balance/index';
import { setBtcPriceEnabled } from '../addons/btc-price/index';

interface DomainAddon {
  /** AddonLoader registry id (differs from the domain id for majlis). */
  addonId: string;
  /** The addon's master enabled flag (PerAccountLocalStorage + fallback). */
  setEnabled(enabled: boolean): void;
}

/** Addon-backed focus domains. List-backed domains are absent (see header). */
const DOMAIN_ADDONS: Record<string, DomainAddon> = {
  analytics: { addonId: 'analytics', setEnabled: setAnalyticsEnabled },
  badges: { addonId: 'badges', setEnabled: setBadgesEnabled },
  'bulk-delete': { addonId: 'bulk-delete', setEnabled: setBulkDeleteEnabled },
  calendar: { addonId: 'calendar', setEnabled: setCalendarEnabled },
  'word-filter': {
    addonId: 'wordfilter',
    setEnabled: setContentWordFilterEnabled,
  },
  'custom-emojis': {
    addonId: 'custom-emojis',
    setEnabled: setCustomEmojisEnabled,
  },
  'feedback-board': {
    addonId: 'feedback-board',
    setEnabled: setFeedbackBoardEnabled,
  },
  'follow-packs': {
    addonId: 'follow-packs',
    setEnabled: setFollowPacksEnabled,
  },
  'follower-notification': {
    addonId: 'follower-notification',
    setEnabled: setFollowerNotificationEnabled,
  },
  'group-chats': { addonId: 'group-chats', setEnabled: setGroupChatsEnabled },
  'hashtag-subscriptions': {
    addonId: 'hashtag-subscriptions',
    setEnabled: setHashtagSubscriptionsEnabled,
  },
  'live-streams': {
    addonId: 'live-streams',
    setEnabled: setLiveStreamsEnabled,
  },
  marketplace: { addonId: 'marketplace', setEnabled: setMarketplaceEnabled },
  majlis: { addonId: 'nostr-majlis', setEnabled: setNostrMajlisEnabled },
  'note-taking': { addonId: 'note-taking', setEnabled: setNoteTakingEnabled },
  'scheduled-posts': {
    addonId: 'scheduled-posts',
    setEnabled: setScheduledPostsEnabled,
  },
  'wallet-balance': {
    addonId: 'wallet-balance',
    setEnabled: setWalletBalanceEnabled,
  },
  'btc-price': {
    addonId: 'btc-price',
    setEnabled: setBtcPriceEnabled,
  },
};

/**
 * Service-backed focus domains (Phase 4.5 "Live-Sub-Stilllegung"):
 * messages + notifications are not addon-backed — their machinery is
 * the dms / notifications module API (start/stop). Hide = stop(): the
 * service unsubscribes its live subs (dm-subscription, notifications-
 * ptag/etag) and clears its timers. Unhide = fresh start(): both
 * services self-guard (no user → no-op), and the module runtimes init
 * at login (activation: 'login'), so getApi() is available post-login;
 * ensure() covers the pre-login edge.
 */
const SERVICE_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  messages: 'dms',
  notifications: 'notifications',
});

/**
 * Consistency guard: the setter map's id pairs must match the pure leaf
 * map (hiddenAddonDomains.ts) — a drift breaks the load-guard budget
 * math silently.
 */
if (import.meta.env?.DEV) {
  for (const [id, addonId] of Object.entries(HIDDEN_ADDON_DOMAINS)) {
    const entry = DOMAIN_ADDONS[id];
    if (!entry || entry.addonId !== addonId) {
      console.error(
        `[domainShutdown] id map drift for "${id}": ` +
          `expected addon "${addonId}", got "${entry?.addonId ?? 'missing'}"`
      );
    }
  }
}

/**
 * Apply the hidden-set delta to the addons: newly hidden addon domains
 * go OFF (runtime destroyed via <id>:addon-toggle), newly unhidden ones
 * go ON (fresh lazy load). The setter runs BEFORE the event — activate()
 * checks isEnabled() and would otherwise skip the load.
 */
export function applyDomainShutdown(
  previousHidden: readonly string[],
  nextHidden: readonly string[]
): void {
  const newlyHidden = nextHidden.filter(id => !previousHidden.includes(id));
  const newlyShown = previousHidden.filter(id => !nextHidden.includes(id));
  for (const [id, newly] of [
    ...newlyHidden.map(id => [id, false] as const),
    ...newlyShown.map(id => [id, true] as const),
  ]) {
    const addon = DOMAIN_ADDONS[id];
    if (!addon) {
      const moduleId = SERVICE_DOMAINS[id];
      if (!moduleId) continue;
      const loader = ModuleLoader.getInstance();
      if (newly) {
        // Unhide: fresh start. ensure() covers the edge where the module
        // runtime is not initialized yet; both services self-guard (no
        // logged-in user → no-op).
        void loader
          .ensure(moduleId)
          .then(api => {
            if (moduleId === 'dms') void (api as DMsModuleApi | null)?.start();
            else void (api as NotificationsModuleApi | null)?.start();
          })
          .catch(() => {}); // module load failure — nothing to start
      } else {
        // Hide: stop the machinery (live subs closed, timers cleared).
        if (moduleId === 'dms') loader.getApi<DMsModuleApi>(moduleId)?.stop();
        else loader.getApi<NotificationsModuleApi>(moduleId)?.stop();
      }
      diagLog(
        'system',
        newly ? 'domain_service_start' : 'domain_service_stop',
        {
          domain: id,
          moduleId,
          reason: 'hidden-objects',
        }
      );
      continue;
    }
    addon.setEnabled(newly);
    diagLog('addons', newly ? 'addons_toggle_off' : 'addons_toggle_on', {
      id: addon.addonId,
      reason: 'hidden-objects',
    });
    // Same event the classic settings toggle emits — the AddonLoader
    // loads/destroys the single addon (dynamic event name, declared in
    // events.ts — cast like AddonToggleView does).
    TypedEventBus.getInstance().emit(
      `${addon.addonId}:addon-toggle` as AppEventName,
      {
        enabled: newly,
      }
    );
  }
}
