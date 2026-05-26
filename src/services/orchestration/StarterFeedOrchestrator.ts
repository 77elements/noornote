/**
 * StarterFeedOrchestrator - Curated timeline for logged-out users
 * Shows posts from a hardcoded list of starter accounts
 *
 * @orchestrator StarterFeedOrchestrator
 * @purpose Provide preview timeline for non-authenticated users
 * @used-by Timeline (when logged out)
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../SystemLogger';
import { STARTER_ACCOUNTS } from './configs/StarterAccountsConfig';
import { npubToHex } from '../../helpers/nip19';

export interface StarterFeedResult {
  events: NostrEvent[];
  hasMore: boolean;
}

export class StarterFeedOrchestrator extends Orchestrator {
  private static instance: StarterFeedOrchestrator;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  /** Hex pubkeys of starter accounts (converted from npubs) */
  private starterPubkeysHex: string[] = [];

  private constructor() {
    super('StarterFeedOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    // Convert npubs to hex pubkeys
    this.starterPubkeysHex = STARTER_ACCOUNTS
      .map(npub => {
        try {
          return npubToHex(npub);
        } catch {
          this.systemLogger.warn('StarterFeedOrchestrator', `Invalid npub: ${npub}`);
          return null;
        }
      })
      .filter((hex): hex is string => hex !== null);

    this.systemLogger.info(
      'StarterFeedOrchestrator',
      `Initialized with ${this.starterPubkeysHex.length} starter accounts`
    );
  }

  public static getInstance(): StarterFeedOrchestrator {
    if (!StarterFeedOrchestrator.instance) {
      StarterFeedOrchestrator.instance = new StarterFeedOrchestrator();
    }
    return StarterFeedOrchestrator.instance;
  }

  /**
   * Load initial starter feed
   */
  public async loadInitialFeed(timeWindowHours: number = 24): Promise<StarterFeedResult> {
    this.systemLogger.info(
      'StarterFeedOrchestrator',
      `Loading starter feed (${timeWindowHours}h window)`
    );

    try {
      const relays = this.relayConfig.getAggregatorRelays();
      const since = Math.floor(Date.now() / 1000) - (timeWindowHours * 3600);

      const filters: NDKFilter<number>[] = [{
        authors: this.starterPubkeysHex,
        kinds: [1, 6, 16, 20, 21, 22, 1068], // Text notes + reposts + generic reposts + videos + polls
        since,
        limit: 50
      }];

      const events = await this.transport.fetch(relays, filters, 8000, false, 'StarterFeedOrch');

      // Deduplicate
      const uniqueEvents = Array.from(
        new Map(events.map(e => [e.id, e])).values()
      );

      // Filter replies
      const filteredEvents = this.filterReplies(uniqueEvents);

      // Sort by timestamp (newest first)
      filteredEvents.sort((a, b) => b.created_at - a.created_at);

      this.systemLogger.info(
        'StarterFeedOrchestrator',
        `Loaded ${filteredEvents.length} starter notes`
      );

      // Auto-expand window if too few results
      if (filteredEvents.length < 10 && timeWindowHours < 168) {
        this.systemLogger.info(
          'StarterFeedOrchestrator',
          `Only ${filteredEvents.length} notes, expanding window...`
        );
        return this.loadInitialFeed(timeWindowHours * 2);
      }

      return {
        events: filteredEvents.slice(0, 50),
        hasMore: true
      };
    } catch (error) {
      this.systemLogger.error('StarterFeedOrchestrator', `Load failed: ${error}`);
      return {
        events: [],
        hasMore: false
      };
    }
  }

  /**
   * Load more events (infinite scroll)
   */
  public async loadMore(until: number, timeWindowHours: number = 24): Promise<StarterFeedResult> {
    this.systemLogger.info(
      'StarterFeedOrchestrator',
      `Loading more before ${new Date(until * 1000).toISOString()}`
    );

    try {
      const relays = this.relayConfig.getAggregatorRelays();
      const since = until - (timeWindowHours * 3600);

      const filters: NDKFilter<number>[] = [{
        authors: this.starterPubkeysHex,
        kinds: [1, 6, 16, 21, 22],
        until: until - 1,
        since,
        limit: 50
      }];

      const events = await this.transport.fetch(relays, filters, 8000, false, 'StarterFeedOrch');

      // Deduplicate
      const uniqueEvents = Array.from(
        new Map(events.map(e => [e.id, e])).values()
      );

      // Filter replies
      const filteredEvents = this.filterReplies(uniqueEvents);

      // Sort by timestamp
      filteredEvents.sort((a, b) => b.created_at - a.created_at);

      this.systemLogger.info(
        'StarterFeedOrchestrator',
        `Loaded ${filteredEvents.length} more notes`
      );

      return {
        events: filteredEvents.slice(0, 50),
        hasMore: filteredEvents.length > 0
      };
    } catch (error) {
      this.systemLogger.error('StarterFeedOrchestrator', `Load more failed: ${error}`);
      return {
        events: [],
        hasMore: false
      };
    }
  }

  /**
   * Get starter account pubkeys (hex)
   */
  public getStarterPubkeys(): string[] {
    return [...this.starterPubkeysHex];
  }

  /**
   * Filter out replies
   */
  private filterReplies(events: NostrEvent[]): NostrEvent[] {
    return events.filter(event => {
      // Always allow reposts (kind 6), videos (kind 21/22), and polls (kind 1068)
      if (event.kind === 6 || event.kind === 16 || event.kind === 1068 || event.kind === 21 || event.kind === 22) return true;

      // Content-based: starts with @username or npub
      const content = event.content.trim();
      if (content.match(/^@\w+/) || content.startsWith('npub1')) {
        return false;
      }

      // Tag-based: has 'e' tags (reply)
      const eTags = event.tags.filter(tag => tag[0] === 'e');
      if (eTags.length > 0) {
        return false;
      }

      return true;
    });
  }

  // Orchestrator interface (minimal implementation)

  public onui(_data: any): void {}
  public onopen(_relay: string): void {}
  public onmessage(_relay: string, _event: NostrEvent): void {}
  public onerror(_relay: string, error: Error): void {
    this.systemLogger.error('StarterFeedOrchestrator', `Relay error: ${error.message}`);
  }
  public onclose(_relay: string): void {}

  public override destroy(): void {
    super.destroy();
    this.systemLogger.info('StarterFeedOrchestrator', 'Destroyed');
  }
}
