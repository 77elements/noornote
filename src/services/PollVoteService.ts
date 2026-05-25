/**
 * PollVoteService - NIP-88 Poll Voting Service
 * Handles creation and publishing of kind:1018 poll response events
 *
 * NIP-88: https://github.com/nostr-protocol/nips/blob/master/88.md
 */

import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from './SystemLogger';

export interface VoteOptions {
  /** Poll event ID to vote on */
  pollEventId: string;
  /** Option IDs to vote for (array for multiplechoice) */
  optionIds: string[];
  /** Target relays to publish to (from poll's relay tags or defaults) */
  relays: string[];
}

export class PollVoteService {
  private static instance: PollVoteService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): PollVoteService {
    if (!PollVoteService.instance) {
      PollVoteService.instance = new PollVoteService();
    }
    return PollVoteService.instance;
  }

  /**
   * Cast a vote on a poll (NIP-88)
   * Creates and publishes a kind:1018 poll response event
   *
   * @param options - Vote configuration
   * @returns Promise<boolean> - Success status
   */
  public async castVote(options: VoteOptions): Promise<boolean> {
    const { pollEventId, optionIds, relays } = options;

    // Validate authentication
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('PollVoteService', 'Cannot cast vote: User not authenticated');
      return false;
    }

    // Validate poll event ID
    if (!pollEventId || pollEventId.trim().length === 0) {
      this.systemLogger.error('PollVoteService', 'Cannot cast vote: Poll event ID is empty');
      return false;
    }

    // Validate option IDs
    if (!optionIds || optionIds.length === 0) {
      this.systemLogger.error('PollVoteService', 'Cannot cast vote: No option IDs specified');
      return false;
    }

    // Validate relays
    if (!relays || relays.length === 0) {
      this.systemLogger.error('PollVoteService', 'Cannot cast vote: No relays specified');
      return false;
    }

    try {
      // Build tags for kind:1018 response event (NIP-88)
      const tags: string[][] = [];

      // Add 'e' tag referencing the poll event
      tags.push(['e', pollEventId]);

      // Add 'response' tag(s) for selected option(s)
      optionIds.forEach(optionId => {
        tags.push(['response', optionId]);
      });

      // Build unsigned event
      const unsignedEvent = {
        kind: 1018,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '', // NIP-88: content is typically empty for responses
        pubkey: currentUser.pubkey
      };

      // Sign event using browser extension
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error('PollVoteService', 'Failed to sign vote event');
        return false;
      }

      // Publish to specified relays
      await this.transport.publish(relays, signedEvent);

      this.systemLogger.info(
        'PollVoteService',
        `Vote cast on poll ${pollEventId.slice(0, 8)}... (${optionIds.length} option${optionIds.length > 1 ? 's' : ''})`
      );

      return true;
    } catch (_error) {
      this.systemLogger.error('PollVoteService', `Failed to cast vote: ${_error}`);
      return false;
    }
  }
}
