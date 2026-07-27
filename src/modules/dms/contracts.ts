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
  /**
   * Per-conversation disappearing-messages setting.
   *   undefined → undecided (no commitment yet)
   *   0         → off
   *   >0        → seconds; outgoing messages get an `expiration` tag.
   */
  getDisappearing(partnerPubkey: string): Promise<number | undefined>;
  setDisappearing(partnerPubkey: string, seconds: number | undefined): Promise<void>;
  /** Read the peer duration we last prompted the user about (Yes or No). */
  getLastPromptedPeerDuration(partnerPubkey: string): Promise<number | undefined>;
  /** Record that we've prompted about this duration (used by the No handler). */
  setLastPromptedPeerDuration(partnerPubkey: string, seconds: number): Promise<void>;
  /** Delete all pending incoming messages with the given peer-duration. */
  deletePendingMessagesByDuration(partnerPubkey: string, duration: number): Promise<number>;
  deleteConversation(partnerPubkey: string): Promise<void>;
  deleteAndMute(partnerPubkey: string): Promise<void>;
  resyncAll(): Promise<void>;
  loadOlderMessages(): Promise<{ fetched: number; reachedEnd: boolean }>;
  start(): Promise<void>;
  stop(): void;
}
