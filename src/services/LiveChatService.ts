/**
 * LiveChatService - NIP-53 Live Chat Message Publishing
 * Handles creation and publishing of Kind 1311 (live chat message) events
 *
 * Kind 1311: Live Chat Message
 * NIP-53: https://github.com/nostr-protocol/nips/blob/master/53.md
 */

import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from './SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { diagLog } from './DiagnosticLogger';

export interface LiveChatMessageOptions {
  /** Addressable ID of the stream: "30311:<pubkey>:<d>" */
  addressableId: string;
  /** Message content */
  content: string;
  /** Target relays to publish to */
  relays: string[];
}

export class LiveChatService {
  private static instance: LiveChatService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): LiveChatService {
    if (!LiveChatService.instance) {
      LiveChatService.instance = new LiveChatService();
    }
    return LiveChatService.instance;
  }

  public async publishMessage(options: LiveChatMessageOptions): Promise<{ success: boolean; error?: string }> {
    const { addressableId, content, relays } = options;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      ToastService.show('You must be logged in to chat', 'error');
      return { success: false, error: 'Not authenticated' };
    }

    const trimmed = content.trim();
    if (!trimmed) {
      return { success: false, error: 'Empty message' };
    }

    if (!addressableId) {
      ToastService.show('Invalid stream', 'error');
      return { success: false, error: 'Invalid addressableId' };
    }

    if (!relays || relays.length === 0) {
      ToastService.show('No relays configured', 'error');
      return { success: false, error: 'No relays configured' };
    }

    try {
      const unsignedEvent = {
        kind: 1311,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', addressableId, '', 'root']
        ],
        content: trimmed,
        pubkey: currentUser.pubkey
      };

      this.systemLogger.info('LiveChatService', `Publishing chat message to ${addressableId}`);

      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        ToastService.show('Signing failed', 'error');
        return { success: false, error: 'Signing failed' };
      }

      const accepted = await this.transport.publish(relays, signedEvent);

      const acceptedUrls = Array.from(accepted);
      const missed = relays.filter(r => !accepted.has(r));

      this.systemLogger.info(
        'LiveChatService',
        `Chat message accepted by ${acceptedUrls.length}/${relays.length} relay(s)`
      );
      this.systemLogger.info('LiveChatService', `Accepted: ${acceptedUrls.join(', ') || '(none)'}`);
      if (missed.length > 0) {
        this.systemLogger.warn('LiveChatService', `Missed: ${missed.join(', ')}`);
      }

      console.log('[LiveChatService] Publish result', {
        addressableId,
        eventId: signedEvent.id,
        targeted: relays,
        accepted: acceptedUrls,
        missed,
      });

      diagLog('relays', 'LiveChat publish', {
        addressableId,
        eventId: signedEvent.id,
        targeted: relays,
        accepted: acceptedUrls,
        missed,
      });

      ToastService.show('Message sent', 'success');

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      ErrorService.handle(
        error,
        'LiveChatService.publishMessage',
        true,
        errorMsg
      );
      return { success: false, error: errorMsg };
    }
  }
}
