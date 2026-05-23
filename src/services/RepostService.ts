/**
 * RepostService - Repost Publishing Service
 * Handles creation and publishing of Kind 6 (repost) events
 *
 * Kind 6: Repost (standard repost)
 * NIP-18: https://github.com/nostr-protocol/nips/blob/master/18.md
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from '../components/system/SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { ReactionsOrchestrator } from './orchestration/ReactionsOrchestrator';
import { OutboundRelaysOrchestrator } from './orchestration/OutboundRelaysOrchestrator';
import { getTag } from '../helpers/tagUtils';

export interface RepostOptions {
  /** Note to repost (full event) */
  originalEvent: NostrEvent;
  /** Optional relay-hints harvested from the reposted event (e-tag relay
   *  hint, source-relay if known). Service additionally resolves the
   *  original author's NIP-65 write-relays via OutboundRelaysOrchestrator
   *  so the repost reaches their inbox-set. */
  relayHints?: string[];
}

export class RepostService {
  private static instance: RepostService;
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

  public static getInstance(): RepostService {
    if (!RepostService.instance) {
      RepostService.instance = new RepostService();
    }
    return RepostService.instance;
  }

  /**
   * Check if current user has already reposted a note
   *
   * @param noteId - Note ID to check
   * @returns Promise<boolean> - True if user has already reposted
   */
  public async hasUserReposted(noteId: string): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return false;

    try {
      const stats = await this.reactionsOrchestrator.getDetailedStats(noteId);

      // Check if any repost event is from the current user
      const userRepost = stats.repostEvents.find(
        event => event.pubkey === currentUser.pubkey
      );

      return !!userRepost;
    } catch (error) {
      this.systemLogger.warn('RepostService', 'Failed to check if user reposted note:', error);
      return false;
    }
  }

  /**
   * Create and publish a Kind 6 repost event
   *
   * @param options - Repost configuration
   * @returns Promise<{ success: boolean; alreadyReposted?: boolean; error?: string }> - Result status
   */
  public async publishRepost(options: RepostOptions): Promise<{ success: boolean; alreadyReposted?: boolean; error?: string }> {
    const { originalEvent, relayHints = [] } = options;

    // Validate authentication
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('RepostService', 'Cannot publish repost: User not authenticated');
      ToastService.show('Du musst eingeloggt sein, um zu reposten', 'error');
      return { success: false, error: 'Not authenticated' };
    }

    // Validate inputs
    if (!originalEvent || !originalEvent.id) {
      this.systemLogger.error('RepostService', 'Cannot publish repost: Missing original event');
      ToastService.show('Invalid note data', 'error');
      return { success: false, error: 'Invalid note data' };
    }

    if (this.transport.getWriteRelays().length === 0) {
      this.systemLogger.error('RepostService', 'Cannot publish repost: No write-relays configured');
      ToastService.show('Keine Relays konfiguriert', 'error');
      return { success: false, error: 'No relays configured' };
    }

    // Check if user has already reposted this note
    const alreadyReposted = await this.hasUserReposted(originalEvent.id);
    if (alreadyReposted) {
      this.systemLogger.info('RepostService', `User has already reposted note ${originalEvent.id.slice(0, 8)}...`);
      ToastService.show('Du hast diesen Note schon reposted', 'info');
      return { success: false, alreadyReposted: true };
    }

    try {
      // Build tags array (NIP-18)
      const tags: string[][] = [
        ['e', originalEvent.id],        // Event being reposted
        ['p', originalEvent.pubkey]     // Author of the event being reposted
      ];

      // Build unsigned event
      // Per NIP-18: content can be stringified JSON of original event or empty
      // We use stringified JSON for better relay compatibility
      const unsignedEvent = {
        kind: 6,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: JSON.stringify(originalEvent),  // Stringified original event
        pubkey: currentUser.pubkey
      };

      this.systemLogger.info('RepostService', `Publishing repost to note ${originalEvent.id.slice(0, 8)}...`);

      // Sign event using browser extension
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error('RepostService', 'Failed to sign repost event');
        ToastService.show('Signierung fehlgeschlagen', 'error');
        return { success: false, error: 'Signing failed' };
      }

      // Resolve the reposted-event author's NIP-65 outbox so the
      // repost reaches their inbox-set — combined with any caller-
      // supplied relay-hints (e-tag relay-hint).
      let authorOutbox: string[] = [];
      try {
        authorOutbox = await OutboundRelaysOrchestrator.getInstance()
          .getCombinedRelays([originalEvent.pubkey], true);
      } catch { /* fall back to relayHints + own write-relays only */ }
      const hints = [...new Set([...relayHints, ...authorOutbox])];

      const acceptedRelays = await this.transport.publishWithHints(signedEvent, hints);

      this.systemLogger.info(
        'RepostService',
        `Repost published to ${acceptedRelays.size} relay(s): note ${originalEvent.id.slice(0, 8)}...`
      );

      // Show success toast to user
      ToastService.show('Repost published successfully', 'success');

      return { success: true };
    } catch (error) {
      // Centralized error handling with user notification
      ErrorService.handle(
        error,
        'RepostService.publishRepost',
        true,
        'Repost konnte nicht veröffentlicht werden. Bitte versuche es erneut.'
      );
      return { success: false, error: 'Publish failed' };
    }
  }

  /**
   * Create and publish a Kind 16 generic repost (NIP-18)
   * Used for non-Kind-1 events (e.g. Kind 30402 marketplace listings).
   */
  public async publishGenericRepost(options: RepostOptions): Promise<{ success: boolean; error?: string }> {
    const { originalEvent, relayHints = [] } = options;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      ToastService.show('Not authenticated', 'error');
      return { success: false, error: 'Not authenticated' };
    }
    if (!originalEvent?.id) {
      return { success: false, error: 'Invalid input' };
    }
    if (this.transport.getWriteRelays().length === 0) {
      ToastService.show('Keine Relays konfiguriert', 'error');
      return { success: false, error: 'No relays configured' };
    }

    try {
      const tags: string[][] = [
        ['e', originalEvent.id],
        ['p', originalEvent.pubkey],
        ['k', String(originalEvent.kind)],
      ];

      // For addressable events (kind 30000-39999), include a-tag
      const eventKind = originalEvent.kind ?? 0;
      if (eventKind >= 30000 && eventKind < 40000) {
        const dTag = getTag(originalEvent.tags, 'd');
        if (dTag) {
          tags.push(['a', `${originalEvent.kind}:${originalEvent.pubkey}:${dTag}`]);
        }
      }

      const unsignedEvent = {
        kind: 16,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: JSON.stringify(originalEvent),
        pubkey: currentUser.pubkey
      };

      const signedEvent = await this.authService.signEvent(unsignedEvent);
      if (!signedEvent) {
        ToastService.show('Signing failed', 'error');
        return { success: false, error: 'Signing failed' };
      }

      let authorOutbox: string[] = [];
      try {
        authorOutbox = await OutboundRelaysOrchestrator.getInstance()
          .getCombinedRelays([originalEvent.pubkey], true);
      } catch { /* fall back to relayHints + own write-relays only */ }
      const hints = [...new Set([...relayHints, ...authorOutbox])];

      await this.transport.publishWithHints(signedEvent, hints);
      this.systemLogger.info('RepostService', `Generic repost (kind ${originalEvent.kind}) published`);
      ToastService.show('Repost published', 'success');
      return { success: true };
    } catch (error) {
      ErrorService.handle(error, 'RepostService.publishGenericRepost', true, 'Repost failed');
      return { success: false, error: 'Publish failed' };
    }
  }
}
