export interface ZapResult {
  success: boolean;
  preimage?: string;
  error?: string;
  amount?: number;
}

export interface ZapsModuleApi {
  sendQuickZap(noteId: string, authorPubkey: string, articleEventId?: string): Promise<ZapResult>;
  sendCustomZap(noteId: string | undefined, authorPubkey: string, amount: number, comment?: string, articleEventId?: string, anonymous?: boolean): Promise<ZapResult>;
  isOwnAnonZapInvoice(invoice: string): boolean;
  getUserZapAmount(noteId: string): number;
  hasUserZapped(noteId: string): boolean;
}
