/**
 * PerAccountLocalStorage
 * Stores per-user data as Maps in localStorage (Jumble Pattern)
 *
 * Architecture:
 * - One localStorage key per setting type
 * - Value is JSON Map: { pubkey: value, pubkey2: value2 }
 * - Synchronous read/write - no async, no data loss
 *
 * @service PerAccountLocalStorage
 * @purpose Isolate user-specific state during account switches
 */

import { AuthService } from './AuthService';

export const StorageKeys = {
  // Existing keys
  NOTIFICATIONS_LAST_SEEN: 'noornote_notifications_seen_map',
  NOTIFICATIONS_CACHE: 'noornote_notifications_cache_map',
  USER_EVENT_IDS: 'noornote_user_event_ids_map',
  USER_EVENT_ANCESTRY: 'noornote_user_event_ancestry_map',
  ZAP_DEFAULTS: 'noornote_zap_defaults_map',
  VIEW_TABS_RIGHT_PANE: 'noornote_view_tabs_right_pane_map', // DEPRECATED - use LAYOUT_MODE

  // List storage (per-account)
  BOOKMARKS: 'noornote_bookmarks_map',
  BOOKMARK_FOLDERS: 'noornote_bookmark_folders_map',
  BOOKMARK_FOLDER_ASSIGNMENTS: 'noornote_bookmark_folder_assignments_map',
  BOOKMARK_ROOT_ORDER: 'noornote_bookmark_root_order_map',
  FOLLOWS: 'noornote_follows_map',
  MUTES: 'noornote_mutes_map',
  TRIBES: 'noornote_tribes_map',
  TRIBE_FOLDERS: 'noornote_tribe_folders_map',
  TRIBE_MEMBER_ASSIGNMENTS: 'noornote_tribe_member_assignments_map',
  TRIBE_ROOT_ORDER: 'noornote_tribe_root_order_map',

  // Notification subscriptions (per-account)
  HASHTAG_SUBSCRIPTIONS: 'noornote_hashtag_subscriptions_map',

  // Profile recognition (per-account)
  PROFILE_ENCOUNTERS: 'noornote_profile_encounters_map',

  // Calendar system preference (per-account)
  CALENDAR_SYSTEM: 'noornote_calendar_system_map',

  // UI preferences (per-account)
  DISABLE_POST_TRUNCATION: 'noornote_disable_post_truncation_map',
  LAYOUT_MODE: 'noornote_layout_mode_map', // 'default' | 'right-pane' | 'wide'

  // NWC storage preference (per-account)
  NWC_USE_ENCRYPTED_FILE: 'noornote_nwc_use_encrypted_file_map', // boolean: true = encrypted file, false = keychain

  // Relay list cache (per-account) - NIP-65 kind:10002 + NIP-17 kind:10050
  RELAY_LIST: 'noornote_relay_list_map',
  RELAY_LIST_TIMESTAMP: 'noornote_relay_list_timestamp_map',
  INBOX_RELAY_LIST_TIMESTAMP: 'noornote_inbox_relay_list_timestamp_map',

  // Notification priority settings (per-account)
  NOTIFICATION_PRIORITIES: 'noornote_notification_priorities_map',

  // Onboarding wizard (per-account)
  NEEDS_PROFILE_SETUP: 'noornote_needs_profile_setup_map',
  WIZARD_PROGRESS: 'noornote_wizard_progress_map',

  // Mutual change detection (per-account)
  MUTUAL_SNAPSHOT: 'noornote_mutual_snapshot_map',
  MUTUAL_PENDING_SNAPSHOT: 'noornote_mutual_pending_snapshot_map',
  MUTUAL_LAST_CHECK: 'noornote_mutual_last_check_map',
  MUTUAL_UNSEEN_CHANGES: 'noornote_mutual_unseen_changes_map',
  MUTUAL_CHANGES: 'noornote_mutual_changes_map',

  // Quick Zap toggle (per-account)
  QUICK_ZAP_ENABLED: 'noornote_quick_zap_enabled_map',

  // Font size preference (per-account)
  FONT_SIZE_SCALE: 'noornote_font_size_scale_map',

  // Addon feature flags (per-account)
  FOLLOW_PACKS_ENABLED: 'noornote_follow_packs_enabled_map',
  MARKETPLACE_ENABLED: 'noornote_marketplace_enabled_map',
  MARKETPLACE_TIMELINE_ENABLED: 'noornote_marketplace_timeline_enabled_map',
  MARKETPLACE_TIMELINE_FREQUENCY: 'noornote_marketplace_timeline_frequency_map',
  HASHTAG_SUBSCRIPTIONS_ENABLED: 'noornote_hashtag_subscriptions_enabled_map',
  PROFILE_RECOGNITION_WINDOW: 'noornote_profile_recognition_window_map',
  LIST_SETTINGS_ENABLED: 'noornote_list_settings_enabled_map',
  NOSTRIN_ENABLED: 'noornote_nostrin_enabled_map',
  CONTENT_WORD_FILTER_ENABLED: 'noornote_content_word_filter_enabled_map',
  CONTENT_WORD_FILTER_WORDS: 'noornote_content_word_filter_words_map',
  BOOKMARKS_ADDON_ENABLED: 'noornote_bookmarks_addon_enabled_map',
  TRIBES_ADDON_ENABLED: 'noornote_tribes_addon_enabled_map',
  EXTENDED_FOLLOWS_ADDON_ENABLED: 'noornote_extended_follows_addon_enabled_map',

  // List privacy flags (per-account)
  PRIVATE_TRIBES_ENABLED: 'noornote_private_tribes_enabled_map',
  PRIVATE_FOLLOWS_ENABLED: 'noornote_private_follows_enabled_map',
  FOLLOWS_FILE_MIGRATION: 'noornote_follows_file_migration_map',
  PRIVATE_BOOKMARKS_ENABLED: 'noornote_private_bookmarks_enabled_map',
  PRIVATE_MUTES_ENABLED: 'noornote_private_mutes_enabled_map',
  MUTE_ENCRYPTION_METHOD: 'noornote_mute_encryption_method_map',

  // Media & display (per-account)
  MEDIA_SERVER: 'noornote_media_server_map',
  SENSITIVE_MEDIA: 'noornote_sensitive_media_map',
  WALLET_BALANCE_VISIBLE: 'noornote_wallet_balance_visible_map',

  // Service data (per-account)
  PROFILE_MOUNTS: 'noornote_profile_mounts_map',
  NOSTRIN_LIST: 'noornote_nostrin_list_map',
  LIST_SYNC_MODE: 'noornote_list_sync_mode_map',
  EMOJI_FREQUENTLY_USED: 'noornote_emoji_frequently_used_map',
  ARTICLE_NOTIFICATIONS: 'noornote_article_notifications_map',
  NOTIFICATIONS_CACHE_VERSION: 'noornote_notifications_cache_version_map',
  NOTIFICATIONS_CACHE_LIMIT: 'noornote_notifications_cache_limit_map',
  SUBMITTED_REPORTS: 'noornote_submitted_reports_map',
  FIAT_CURRENCY: 'noornote_fiat_currency_map',
  USER_ZAPS: 'noornote_user_zaps_map',

  // List sync timestamps (Easy Mode timestamp-based sync)
  LIST_LAST_MODIFIED_FOLLOWS: 'noornote_list_lm_follows_map',
  LIST_LAST_MODIFIED_BOOKMARKS: 'noornote_list_lm_bookmarks_map',
  LIST_LAST_MODIFIED_MUTES: 'noornote_list_lm_mutes_map',
  LIST_LAST_MODIFIED_TRIBES: 'noornote_list_lm_tribes_map',
} as const;

export type StorageKey = typeof StorageKeys[keyof typeof StorageKeys];

export type LayoutMode = 'default' | 'right-pane' | 'wide' | 'phone';
export type FontSizeScale = 'small' | 'default' | 'large' | 'x-large';

// Notification priority: 1 = highest (pulsing), 2 = medium (solid), 3 = lowest (hollow)
export type NotificationPriority = 1 | 2 | 3;

// Maps notification type to priority
export type NotificationPriorityMap = Record<string, NotificationPriority>;

export class PerAccountLocalStorage {
  private static instance: PerAccountLocalStorage;

  private constructor() {}

  public static getInstance(): PerAccountLocalStorage {
    if (!PerAccountLocalStorage.instance) {
      PerAccountLocalStorage.instance = new PerAccountLocalStorage();
    }
    return PerAccountLocalStorage.instance;
  }

  /**
   * Get current user's pubkey
   */
  private getCurrentPubkey(): string | null {
    const authService = AuthService.getInstance();
    const user = authService.getCurrentUser();
    return user?.pubkey || null;
  }

  /**
   * Get value for current user
   */
  public get<T>(key: StorageKey, defaultValue: T): T {
    const pubkey = this.getCurrentPubkey();
    if (!pubkey) return defaultValue;

    return this.getForPubkey(key, pubkey, defaultValue);
  }

  /**
   * Get layout mode with automatic migration from legacy VIEW_TABS_RIGHT_PANE
   */
  public getLayoutMode(): LayoutMode {
    const pubkey = this.getCurrentPubkey();
    if (!pubkey) return 'default';

    // Check if LAYOUT_MODE already exists
    const layoutMode = this.getForPubkey<string>(StorageKeys.LAYOUT_MODE, pubkey, 'default');

    // Migration: 'mobile' was renamed to 'phone' in v0.3.8
    if (layoutMode === 'mobile') {
      this.setForPubkey(StorageKeys.LAYOUT_MODE, pubkey, 'phone');
      return 'phone';
    }

    // If already set to non-default, return it
    if (layoutMode !== 'default') {
      return layoutMode as LayoutMode;
    }

    // Migration: Check old VIEW_TABS_RIGHT_PANE setting
    const legacyRightPaneEnabled = this.getForPubkey<boolean>(StorageKeys.VIEW_TABS_RIGHT_PANE, pubkey, false);

    if (legacyRightPaneEnabled) {
      // Migrate: true → 'right-pane'
      const migratedMode: LayoutMode = 'right-pane';
      this.setForPubkey(StorageKeys.LAYOUT_MODE, pubkey, migratedMode);
      return migratedMode;
    }

    // Default case: false → 'default'
    return 'default';
  }

  /**
   * Set layout mode
   */
  public setLayoutMode(mode: LayoutMode): void {
    this.set(StorageKeys.LAYOUT_MODE, mode);
  }

  /**
   * Get value for specific pubkey
   */
  public getForPubkey<T>(key: StorageKey, pubkey: string, defaultValue: T): T {
    try {
      const mapStr = localStorage.getItem(key);
      if (!mapStr) return defaultValue;

      const map = JSON.parse(mapStr) as Record<string, T>;
      return map[pubkey] ?? defaultValue;
    } catch {
      return defaultValue;
    }
  }

  /**
   * Set value for current user (SYNC - no data loss!)
   */
  public set<T>(key: StorageKey, value: T): void {
    const pubkey = this.getCurrentPubkey();
    if (!pubkey) return;

    this.setForPubkey(key, pubkey, value);
  }

  /**
   * Set value for specific pubkey
   * @throws QuotaExceededError if localStorage is full (caller must handle!)
   */
  public setForPubkey<T>(key: StorageKey, pubkey: string, value: T): void {
    const mapStr = localStorage.getItem(key);
    const map = mapStr ? JSON.parse(mapStr) as Record<string, T> : {};
    map[pubkey] = value;
    localStorage.setItem(key, JSON.stringify(map));
  }

  /**
   * Remove value for current user
   */
  public remove(key: StorageKey): void {
    const pubkey = this.getCurrentPubkey();
    if (!pubkey) return;

    this.removeForPubkey(key, pubkey);
  }

  /**
   * Remove value for specific pubkey
   */
  public removeForPubkey(key: StorageKey, pubkey: string): void {
    try {
      const mapStr = localStorage.getItem(key);
      if (!mapStr) return;

      const map = JSON.parse(mapStr) as Record<string, unknown>;
      delete map[pubkey];
      localStorage.setItem(key, JSON.stringify(map));
    } catch (e) {
      console.error('PerAccountLocalStorage.remove failed:', e);
    }
  }

  /**
   * Get entire map (for debugging/migration)
   */
  public getMap<T>(key: StorageKey): Record<string, T> {
    try {
      const mapStr = localStorage.getItem(key);
      if (!mapStr) return {};
      return JSON.parse(mapStr) as Record<string, T>;
    } catch {
      return {};
    }
  }
}
