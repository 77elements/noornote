import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type {
  NotificationType,
  NotificationEvent,
} from '../../services/orchestration/NotificationsOrchestrator';

export type { NotificationType, NotificationEvent };

export interface NotificationsModuleApi {
  getUnreadCount(): number;
  getHighestUnreadPriority(): 1 | 2 | 3 | null;
  refreshSubscriptions(): Promise<void>;
  refreshMutedUsers(): Promise<void>;
  markAsRead(): void;
  start(): Promise<void>;
  stop(): void;

  // Notification list surface
  /** Register the callback fired when a new notification arrives (single slot). */
  onNewNotification(callback: (notification: NotificationEvent) => void): void;
  getNotifications(
    type?: NotificationType,
    offset?: number,
    limit?: number
  ): NotificationEvent[];
  getNotificationCount(type?: NotificationType): number;
  addCachedNotifications(events: NostrEvent[]): void;
  fetchNewNotifications(since: number): Promise<void>;
  fetchOlderNotifications(
    until: number,
    limit?: number
  ): Promise<NotificationEvent[]>;
  getAllNotificationEvents(): NostrEvent[];

  // NotificationsCacheService
  getCacheLimit(): number;
  setCacheLimit(limit: number): void;
  updateLastSeen(): void;
  getCachedNotifications(): NostrEvent[];
  getLastFetch(): number;
  addNotifications(events: NostrEvent[]): void;

  // Notification preview resolution
  /** Fetch an e-tag-referenced event for preview display (k-tag hint optional). */
  fetchReferencedEvent(
    noteId: string,
    kindHint?: number
  ): Promise<NostrEvent | null>;
  /** Fetch an addressable event by `kind:pubkey:d` coordinate for previews. */
  fetchAddressableEventByCoordinate(
    coordinate: string
  ): Promise<NostrEvent | null>;
}
