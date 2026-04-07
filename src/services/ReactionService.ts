/**
 * ReactionService - Like/Reaction Publishing Service
 * Handles creation and publishing of Kind 7 (reaction) events
 *
 * Kind 7: Reaction (like with emoji)
 * NIP-25: https://github.com/nostr-protocol/nips/blob/master/25.md
 */

import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from '../components/system/SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { ReactionsOrchestrator } from './orchestration/ReactionsOrchestrator';

export interface ReactionOptions {
  /** Note ID to react to */
  noteId: string;
  /** Note author pubkey */
  authorPubkey: string;
  /** Emoji reaction (default: ❤️). For NIP-30 custom emojis pass `:shortcode:` here and the matching `emojiTag`. */
  emoji?: string;
  /** Optional NIP-30 emoji tag for custom-emoji reactions: ['emoji', code, url] */
  emojiTag?: [string, string, string];
  /** Target relays to publish to */
  relays: string[];
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
    const { noteId, authorPubkey, emoji = '❤️', emojiTag, relays } = options;

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

    if (!relays || relays.length === 0) {
      this.systemLogger.error('ReactionService', 'Cannot publish reaction: No relays specified');
      ToastService.show('No relays configured', 'error');
      return { success: false, error: 'No relays configured' };
    }

    try {
      // Build tags array (NIP-25)
      const tags: string[][] = [
        ['e', noteId],      // Event being reacted to
        ['p', authorPubkey] // Author of the event being reacted to
      ];

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

      // Publish to specified relays
      await this.transport.publish(relays, signedEvent);

      this.systemLogger.info(
        'ReactionService',
        `Reaction published to ${relays.length} relay(s): ${emoji} on note ${noteId.slice(0, 8)}...`
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
