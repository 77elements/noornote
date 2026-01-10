/**
 * ParentNoteFetcher Service
 * Fetches parent note authors for reply indicators
 * Sequential queue to avoid overwhelming relays
 */

import { fetchNostrEvents } from '../helpers/fetchNostrEvents';
import { RelayConfig } from './RelayConfig';
import { UserProfileService } from './UserProfileService';

interface ParentAuthorInfo {
  displayName: string;
  avatarUrl: string;
  pubkey: string;
}

interface QueueTask {
  parentEventId: string;
  relayHint: string | null;
  resolve: (info: ParentAuthorInfo | null) => void;
  reject: (error: any) => void;
}

export class ParentNoteFetcher {
  private static instance: ParentNoteFetcher;
  private queue: QueueTask[] = [];
  private isProcessing = false;
  private readonly DELAY_MS = 300; // 300ms between requests
  private relayConfig: RelayConfig;
  private userProfileService: UserProfileService;

  private constructor() {
    this.relayConfig = RelayConfig.getInstance();
    this.userProfileService = UserProfileService.getInstance();
  }

  static getInstance(): ParentNoteFetcher {
    if (!ParentNoteFetcher.instance) {
      ParentNoteFetcher.instance = new ParentNoteFetcher();
    }
    return ParentNoteFetcher.instance;
  }

  /**
   * Fetch parent note author info (queued)
   */
  async fetchParentAuthor(parentEventId: string, relayHint: string | null): Promise<ParentAuthorInfo | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ parentEventId, relayHint, resolve, reject });

      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process queue sequentially with delays
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) continue;

      try {
        const info = await this.fetchParentAuthorInternal(task.parentEventId, task.relayHint);
        task.resolve(info);
      } catch (error) {
        task.reject(error);
      }

      // Delay before next request
      if (this.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.DELAY_MS));
      }
    }

    this.isProcessing = false;
  }

  /**
   * Internal fetch logic
   */
  private async fetchParentAuthorInternal(parentEventId: string, relayHint: string | null): Promise<ParentAuthorInfo | null> {
    try {
      // Build relay list: relay hint first, then configured relays
      const configuredRelays = this.relayConfig.getReadRelays();
      const relays = relayHint
        ? [relayHint, ...configuredRelays.filter(r => r !== relayHint)]
        : configuredRelays;

      // Fetch parent event
      const result = await fetchNostrEvents({
        relays,
        ids: [parentEventId],
        limit: 1
      });

      if (result.events.length === 0) {
        return null; // Parent not found
      }

      const parentEvent = result.events[0];
      if (!parentEvent) return null;
      const parentAuthorPubkey = parentEvent.pubkey;

      // Get parent author profile
      const parentProfile = await this.userProfileService.getUserProfile(parentAuthorPubkey);

      // Extract display name and avatar
      const displayName = parentProfile.display_name || parentProfile.name || 'Anonymous';
      const avatarUrl = parentProfile.picture ?? this.userProfileService.getProfilePicture(parentAuthorPubkey) ?? '';

      return {
        displayName,
        avatarUrl,
        pubkey: parentAuthorPubkey
      };

    } catch (error) {
      console.error('Failed to fetch parent author:', error);
      return null;
    }
  }
}
