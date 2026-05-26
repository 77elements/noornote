import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface NotificationsModuleApi {
  getUnreadCount(): number;
  getHighestUnreadPriority(): 1 | 2 | 3 | null;
  refreshSubscriptions(): Promise<void>;
  refreshMutedUsers(): Promise<void>;
  markAsRead(): void;
  start(): Promise<void>;
  stop(): void;

  // NotificationsCacheService
  getCacheLimit(): number;
  setCacheLimit(limit: number): void;
  updateLastSeen(): void;
  getCachedNotifications(): NostrEvent[];
  getLastFetch(): number;
  addNotifications(events: NostrEvent[]): void;
}
