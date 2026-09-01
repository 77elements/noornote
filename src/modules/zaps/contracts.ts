import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ZapPendingState } from '../../services/ZapService';

export interface ZapResult {
  success: boolean;
  preimage?: string;
  error?: string;
  amount?: number;
}

export interface ZapsModuleApi {
  sendQuickZap(
    noteId: string,
    authorPubkey: string,
    articleEventId?: string
  ): Promise<ZapResult>;
  sendCustomZap(
    noteId: string | undefined,
    authorPubkey: string,
    amount: number,
    comment?: string,
    articleEventId?: string,
    anonymous?: boolean
  ): Promise<ZapResult>;
  isOwnAnonZapInvoice(invoice: string): boolean;
  getUserZapAmount(noteId: string): number;
  hasUserZapped(noteId: string): boolean;
  /** Outstanding optimistic zap states for a note (zaps-list merge). */
  getZapPendingStates(noteId: string): ZapPendingState[];
  /** Sum of optimistic amounts for a note (ISL count addition). */
  getUnconfirmedZapAmount(noteId: string): number;
  /** Drop entries whose receipt is present in the fetched stats (no double count). */
  reconcileZapStates(noteId: string, zapEvents: NostrEvent[]): void;
}
