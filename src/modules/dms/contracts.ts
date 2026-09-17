import type { DMConversation, DMMessage } from '../../services/dm/DMStore';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface DMsModuleApi {
  getUnreadCount(): Promise<number>;
  getUnreadCountsSplit(): Promise<{
    known: number;
    unknown: number;
    total: number;
  }>;
  refreshSubscriptions(): Promise<void>;
  sendMessage(
    recipientPubkey: string,
    content: string,
    replyTo?: string
  ): Promise<boolean>;
  getConversations(limit?: number, offset?: number): Promise<DMConversation[]>;
  getConversationsFiltered(
    filter: 'known' | 'unknown' | 'all',
    limit?: number,
    offset?: number
  ): Promise<DMConversation[]>;
  getMessages(
    partnerPubkey: string,
    limit?: number,
    before?: number
  ): Promise<DMMessage[]>;
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
  setDisappearing(
    partnerPubkey: string,
    seconds: number | undefined
  ): Promise<void>;
  /** Read the peer duration we last prompted the user about (Yes or No). */
  getLastPromptedPeerDuration(
    partnerPubkey: string
  ): Promise<number | undefined>;
  /** Record that we've prompted about this duration (used by the No handler). */
  setLastPromptedPeerDuration(
    partnerPubkey: string,
    seconds: number
  ): Promise<void>;
  /** Delete all pending incoming messages with the given peer-duration. */
  deletePendingMessagesByDuration(
    partnerPubkey: string,
    duration: number
  ): Promise<number>;
  deleteConversation(partnerPubkey: string): Promise<void>;
  deleteAndMute(partnerPubkey: string): Promise<void>;
  resyncAll(): Promise<void>;
  loadOlderMessages(): Promise<{ fetched: number; reachedEnd: boolean }>;
  start(): Promise<void>;
  stop(): void;
  /**
   * Shared NIP-59 primitive (calendar private-event invitations): builds the
   * seal+wrap for a kind-14 rumor, injects the ephemeral `signing_nsec` into
   * the encrypted rumor and delivers the wrap to the recipient's inbox relays.
   * Returns the signing key (nsec) so the caller can hand delete-capability
   * to the recipient via the rumor.
   */
  deliverGiftWrap(
    rumor: NostrEvent,
    recipientPubkey: string,
    extraTags?: string[][]
  ): Promise<{ signingNsec: string } | null>;
  /** Unwrap a NIP-59 gift wrap from any producer (anti-spoof checked). */
  unwrapGiftWrapEvent(wrapEvent: NostrEvent): Promise<NostrEvent | null>;
}
