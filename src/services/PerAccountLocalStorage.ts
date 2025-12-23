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
  VIEW_TABS_RIGHT_PANE: 'noornote_view_tabs_right_pane_map',

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
} as const;

export type StorageKey = typeof StorageKeys[keyof typeof StorageKeys];

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
   */
  public setForPubkey<T>(key: StorageKey, pubkey: string, value: T): void {
    try {
      const mapStr = localStorage.getItem(key);
      const map = mapStr ? JSON.parse(mapStr) as Record<string, T> : {};
      map[pubkey] = value;
      localStorage.setItem(key, JSON.stringify(map));
    } catch (e) {
      console.error('PerAccountLocalStorage.set failed:', e);
    }
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
