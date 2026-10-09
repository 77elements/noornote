/**
 * ParentNoteFetcher Service
 * Fetches parent note authors for reply indicators
 * Sequential queue to avoid overwhelming relays
 */

import { fetchNostrEvents } from './FetchNostrEvents';
import { NoteService } from './NoteService';
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
  reject: (error: unknown) => void;
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
  async fetchParentAuthor(
    parentEventId: string,
    relayHint: string | null
  ): Promise<ParentAuthorInfo | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ parentEventId, relayHint, resolve, reject });

      if (!this.isProcessing) {
        void this.processQueue();
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
        const info = await this.fetchParentAuthorInternal(
          task.parentEventId,
          task.relayHint
        );
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
  private async fetchParentAuthorInternal(
    parentEventId: string,
    relayHint: string | null
  ): Promise<ParentAuthorInfo | null> {
    try {
      // Cache-first via NoteService: the parent of a reply is very often
      // already in the LRU (timeline, thread, SNV) — zero REQs. Concurrent
      // lookups for the same parent dedup into one fetch.
      let parentEvent = await NoteService.getInstance().getNote(parentEventId);

      // Fallback: hint-relay fetch for parents that live outside NoteService's
      // read+aggregator set (relay hint = relay the reply was seen on).
      if (!parentEvent && relayHint) {
        const configuredRelays = this.relayConfig.getReadRelays();
        const relays = [
          relayHint,
          ...configuredRelays.filter(r => r !== relayHint),
        ];
        const result = await fetchNostrEvents({
          relays,
          ids: [parentEventId],
          limit: 1,
        });
        parentEvent = result.events[0] ?? null;
      }

      if (!parentEvent) {
        return null; // Parent not found
      }
      const parentAuthorPubkey = parentEvent.pubkey;

      // Get parent author profile
      const parentProfile =
        await this.userProfileService.getUserProfile(parentAuthorPubkey);

      // Extract display name and avatar
      const displayName =
        parentProfile.display_name || parentProfile.name || 'Anonymous';
      const avatarUrl =
        parentProfile.picture ??
        this.userProfileService.getProfilePicture(parentAuthorPubkey) ??
        '';

      return {
        displayName,
        avatarUrl,
        pubkey: parentAuthorPubkey,
      };
    } catch (error) {
      console.error('Failed to fetch parent author:', error);
      return null;
    }
  }
}
