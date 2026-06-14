/**
 * Central policy for addon enabled-flag storage.
 *
 * Every addon stores its enabled flag per-account via PerAccountLocalStorage —
 * that per-account value is the real, authoritative state. A legacy global
 * localStorage key is kept only as a harmless fallback and is ALWAYS held OFF:
 * a brand-new account has no per-account value and therefore reads OFF here, so
 * every addon starts disabled for a new user, no matter what was stored before.
 *
 * Setters write `'false'` to the global key; this function additionally clears
 * any pre-existing `'true'` global values left over from older builds.
 */

// Global (non-per-account) localStorage keys for every addon's enabled flag.
// Keep in sync with the `STORAGE_KEY` constant in each addon's index.ts.
// (note-taking and nostr-majlis are per-account only and have no global key.)
export const ADDON_GLOBAL_ENABLED_KEYS: string[] = [
  'noornote_bulk_delete_enabled',
  'noornote_content_word_filter_enabled',
  'noornote_bookmarks_addon_enabled',
  'noornote_badges_enabled',
  'noornote_follow_packs_enabled',
  'noornote_extended_follows_addon_enabled',
  'noornote_custom_emojis_enabled',
  'noornote_hashtag_subscriptions_enabled',
  'noornote_list_settings_enabled',
  'noornote_live_streams_player_enabled',
  'noornote_profile_recognition_enabled',
  'noornote_follower_notification_enabled',
  'noornote_marketplace_enabled',
  'noornote_tribes_addon_enabled',
  'noornote_scheduled_posts_enabled',
  'noornote_wallet_balance_addon_enabled',
];

/** Force every global addon-enabled key OFF. Run once at app bootstrap. */
export function resetGlobalAddonEnabledFlags(): void {
  for (const key of ADDON_GLOBAL_ENABLED_KEYS) {
    localStorage.setItem(key, 'false');
  }
}
