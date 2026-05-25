export interface DMsModuleApi {
  getUnreadCount(): Promise<number>;
  getUnreadCountsSplit(): Promise<{ known: number; unknown: number; total: number }>;
  refreshSubscriptions(): Promise<void>;
  sendMessage(recipientPubkey: string, content: string, replyTo?: string): Promise<boolean>;
  getConversations(limit?: number, offset?: number): Promise<any[]>;
  getMessages(partnerPubkey: string, limit?: number, before?: number): Promise<any[]>;
  markAsRead(partnerPubkey: string): Promise<void>;
  markAllAsRead(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
}
