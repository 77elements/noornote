export interface NotificationsModuleApi {
  getUnreadCount(): number;
  getHighestUnreadPriority(): 1 | 2 | 3 | null;
  refreshSubscriptions(): Promise<void>;
  refreshMutedUsers(): Promise<void>;
  markAsRead(): void;
  start(): Promise<void>;
  stop(): void;
}
