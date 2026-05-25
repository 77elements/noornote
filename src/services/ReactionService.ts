/**
 * ReactionService - Like/Reaction Publishing Service
 * Handles creation and publishing of Kind 7 (reaction) events
 *
 * Kind 7: Reaction (like with emoji)
 * NIP-25: https://github.com/nostr-protocol/nips/blob/master/25.md
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from './SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { ReactionsOrchestrator } from './orchestration/ReactionsOrchestrator';
import { OutboundRelaysOrchestrator } from './orchestration/OutboundRelaysOrchestrator';
import { getAddressableIdentifier } from '../helpers/getAddressableIdentifier';

export interface ReactionOptions {
  /** Note ID to react to. For non-addressable events this is the hex event-id;
   *  for addressable events (kind 30000–39999) callers historically pass the
   *  addressable identifier here — `targetEvent` (below) takes precedence and
   *  is the correct path for NIP-25-compliant addressable reactions. */
  noteId: string;
  /** Note author pubkey */
  authorPubkey: string;
  /** Emoji reaction (default: ❤️). For NIP-30 custom emojis pass `:shortcode:` here and the matching `emojiTag`. */
  emoji?: string;
  /** Optional NIP-30 emoji tag for custom-emoji reactions: ['emoji', code, url] */
  emojiTag?: [string, string, string];
  /** Optional relay-hints harvested from the reacted-to event (e-tag relay
   *  hint, source-relay if known). Service additionally resolves the
   *  author's NIP-65 write-relays via OutboundRelaysOrchestrator so the
   *  reaction lands on the author's inbox regardless of where the user
   *  saw the note. */
  relayHints?: string[];
  /** The original reacted-to event. When set AND addressable (kind 30000–
   *  39999), the reaction is built per NIP-25:
   *    - `e`-tag carries the actual hex event.id (NOT the addressable id)
   *    - `a`-tag carries `kind:pubkey:dtag`
   *    - `k`-tag carries the original kind
   *  Required for likes on long-form articles (kind:30023) etc.; without it
   *  strict relays (strfry, nostr-rs-relay) reject the e-tag as
   *  "unexpected size for fixed-size tag: e" because they expect 32 bytes
   *  hex but received the colon-separated addressable identifier. Amethyst
   *  builds reactions the same way (quartz ReactionEvent.kt). */
  targetEvent?: NostrEvent;
}

/** Normalize emoji: treat "+" and empty string as ❤️ (NIP-25 convention) */
function normalizeEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  return (trimmed === '+' || trimmed === '') ? '❤️' : trimmed;
}

export class ReactionService {
  private static instance: ReactionService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;
  private reactionsOrchestrator: ReactionsOrchestrator;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.reactionsOrchestrator = ReactionsOrchestrator.getInstance();
  }

  public static getInstance(): ReactionService {
    if (!ReactionService.instance) {
      ReactionService.instance = new ReactionService();
    }
    return ReactionService.instance;
  }

  /**
   * Check if current user has already liked a note
   *
   * @param noteId - Note ID to check
   * @returns Promise<boolean> - True if user has already liked
   */
  public async hasUserLiked(noteId: string): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return false;

    try {
      const stats = await this.reactionsOrchestrator.getDetailedStats(noteId);
      return stats.reactionEvents.some(event => event.pubkey === currentUser.pubkey);
    } catch (_error) {
      this.systemLogger.warn('ReactionService', 'Failed to check if user liked note:', _error);
      return false;
    }
  }

  /**
   * Check if current user has already liked a note with a specific emoji
   *
   * @param noteId - Note ID to check
   * @param emoji - Emoji to check for (e.g. "❤️", "🔥", "👍")
   * @returns Promise<boolean> - True if user has already reacted with this emoji
   */
  public async hasUserLikedWithEmoji(noteId: string, emoji: string): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return false;

    try {
      const stats = await this.reactionsOrchestrator.getDetailedStats(noteId);
      const target = normalizeEmoji(emoji);
      return stats.reactionEvents.some(
        event => event.pubkey === currentUser.pubkey && normalizeEmoji(event.content) === target
      );
    } catch (_error) {
      this.systemLogger.warn('ReactionService', 'Failed to check if user liked note with emoji:', _error);
      return false;
    }
  }

  /**
   * Create and publish a Kind 7 reaction event
   *
   * @param options - Reaction configuration
   * @returns Promise<{ success: boolean; alreadyLiked?: boolean; error?: string }> - Result status
   */
  public async publishReaction(options: ReactionOptions): Promise<{ success: boolean; alreadyLiked?: boolean; error?: string }> {
    const { noteId, authorPubkey, emoji = '❤️', emojiTag, relayHints = [], targetEvent } = options;

    // Validate authentication
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('ReactionService', 'Cannot publish reaction: User not authenticated');
      ToastService.show('You must be logged in to like', 'error');
      return { success: false, error: 'Not authenticated' };
    }

    // Validate inputs
    if (!noteId || !authorPubkey) {
      this.systemLogger.error('ReactionService', 'Cannot publish reaction: Missing noteId or authorPubkey');
      ToastService.show('Invalid note data', 'error');
      return { success: false, error: 'Invalid note data' };
    }

    if (this.transport.getWriteRelays().length === 0) {
      this.systemLogger.error('ReactionService', 'Cannot publish reaction: No write-relays configured');
      ToastService.show('No relays configured', 'error');
      return { success: false, error: 'No relays configured' };
    }

    try {
      // Build tags array (NIP-25)
      //
      // For ADDRESSABLE reacted-to events (kind 30000–39999) we MUST emit the
      // hex event-id in the `e`-tag and add `a` + `k` tags. The legacy code
      // path passes the addressable identifier ("kind:pubkey:dtag") as
      // `noteId` for long-form articles, which is NOT a valid 32-byte hex —
      // strict relays reject it. The caller surfaces the original event
      // via `targetEvent` so we can build the correct tags here.
      const tags: string[][] = [];
      const isAddressable =
        targetEvent?.kind !== undefined &&
        targetEvent.kind >= 30000 &&
        targetEvent.kind < 40000 &&
        !!targetEvent.id;

      if (isAddressable && targetEvent && targetEvent.id) {
        const addressableId = getAddressableIdentifier(targetEvent);
        tags.push(['e', targetEvent.id]);
        if (addressableId) tags.push(['a', addressableId]);
        tags.push(['k', String(targetEvent.kind)]);
        tags.push(['p', authorPubkey]);
      } else {
        tags.push(['e', noteId]);
        tags.push(['p', authorPubkey]);
      }

      // NIP-30: custom emoji reaction — content is `:shortcode:`, tags carry the URL
      if (emojiTag) {
        tags.push([emojiTag[0], emojiTag[1], emojiTag[2]]);
      }

      // Build unsigned event
      const unsignedEvent = {
        kind: 7,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: emoji,  // Emoji as content
        pubkey: currentUser.pubkey
      };

      this.systemLogger.info('ReactionService', `Publishing reaction ${emoji} to note ${noteId.slice(0, 8)}...`);

      // Sign event using browser extension
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error('ReactionService', 'Failed to sign reaction event');
        ToastService.show('Signing failed', 'error');
        return { success: false, error: 'Signing failed' };
      }

      // Resolve the author's NIP-65 outbox so the reaction reliably
      // reaches their inbox-set — even if the user saw the note on a
      // relay that the author doesn't write to. Use the narrow
      // `discoverUserRelays + getOutboundRelays` pair instead of the
      // broad `getCombinedRelays`: the latter unions in the user's own
      // read-set + the aggregator-relays, which then overlap with the
      // primary publish-set and trip NDK's per-relay duplicate-detection
      // (only one OK-resolver gets popped per publish, leaving the
      // other relaySet.publish waiting for a timeout → "0 published, 1
      // required" even when the relay accepted the event).
      // `getOutboundRelays` already excludes anything in the user's
      // read-set internally — so the resulting hint-set is strictly
      // author-specific.
      let authorOutbox: string[] = [];
      try {
        const orch = OutboundRelaysOrchestrator.getInstance();
        const relayLists = await orch.discoverUserRelays([authorPubkey]);
        authorOutbox = orch.getOutboundRelays(relayLists);
      } catch { /* fall back to relayHints + own write-relays only */ }
      const hints = [...new Set([...relayHints, ...authorOutbox])];

      const acceptedRelays = await this.transport.publishWithHints(signedEvent, hints);

      this.systemLogger.info(
        'ReactionService',
        `Reaction published to ${acceptedRelays.size} relay(s): ${emoji} on note ${noteId.slice(0, 8)}...`
      );

      // Show success toast to user
      ToastService.show(`Liked: ${emoji}`, 'success');

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      ErrorService.handle(
        error,
        'ReactionService.publishReaction',
        true,
        errorMsg
      );
      return { success: false, error: errorMsg };
    }
  }
}
