export interface DMsModuleApi {
  getUnreadCount(): Promise<number>;
  getUnreadCountsSplit(): Promise<{ known: number; unknown: number; total: number }>;
  refreshSubscriptions(): Promise<void>;
  sendMessage(recipientPubkey: string, content: string, replyTo?: string): Promise<boolean>;
  getConversations(limit?: number, offset?: number): Promise<any[]>;
  getConversationsFiltered(filter: 'known' | 'unknown' | 'all', limit?: number, offset?: number): Promise<any[]>;
  getMessages(partnerPubkey: string, limit?: number, before?: number): Promise<any[]>;
  getFetchProgress(): { current: number; total: number; isLoading: boolean };
  markAsRead(partnerPubkey: string): Promise<void>;
  markAllAsRead(): Promise<void>;
  markAllAsUnread(): Promise<void>;
  deleteConversation(partnerPubkey: string): Promise<void>;
  deleteAndMute(partnerPubkey: string): Promise<void>;
  resyncAll(): Promise<void>;
  loadOlderMessages(): Promise<{ fetched: number; reachedEnd: boolean }>;
  start(): Promise<void>;
  stop(): void;
}
