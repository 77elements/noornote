/**
 * RelayListOrchestrator - NIP-65 + NIP-17 Relay List Management
 * Handles fetching and publishing user's relay lists (kind:10002, kind:10050)
 *
 * @orchestrator RelayListOrchestrator
 * @purpose Fetch and publish relay lists (read/write + inbox)
 * @used-by RelayConfig, SettingsView
 *
 * Architecture:
 * - Fetches kind:10002 (NIP-65 read/write) and kind:10050 (NIP-17 inbox) on LOGIN
 * - Publishes kind:10002 when user updates settings
 * - Bootstrap relays from config used to fetch
 * - User's relay list syncs across devices
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { SystemLogger } from '../SystemLogger';
import type { RelayInfo, RelayType } from '../RelayConfig';

export class RelayListOrchestrator extends Orchestrator {
  private static instance: RelayListOrchestrator;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  private constructor() {
    super('RelayListOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info('RelayListOrchestrator', 'Initialized');
  }

  public static getInstance(): RelayListOrchestrator {
    if (!RelayListOrchestrator.instance) {
      RelayListOrchestrator.instance = new RelayListOrchestrator();
    }
    return RelayListOrchestrator.instance;
  }

  /**
   * Fetch a replaceable relay list event by kind from bootstrap relays.
   * Shared fetch logic for kind:10002 and kind:10050.
   */
  private async fetchRelayKind(
    pubkey: string,
    kind: number,
    bootstrapRelays: string[],
    parseEvent: (event: NostrEvent) => RelayInfo[]
  ): Promise<{ relays: RelayInfo[]; timestamp: number } | null> {
    const filters: NDKFilter[] = [
      {
        authors: [pubkey],
        kinds: [kind],
        limit: 1,
      },
    ];

    try {
      const events = await this.transport.fetch(
        bootstrapRelays,
        filters,
        5000,
        false,
        'RelayListOrch'
      );

      const event = events[0];
      if (!event) return null;

      return {
        relays: parseEvent(event),
        timestamp: event.created_at ?? 0,
      };
    } catch (error) {
      this.systemLogger.error(
        'RelayListOrchestrator',
        `Fetch kind:${kind} relay list failed: ${error}`
      );
      return null;
    }
  }

  /**
   * Fetch user's relay list (kind:10002) from bootstrap relays
   */
  public async fetchRelayList(
    pubkey: string,
    bootstrapRelays: string[]
  ): Promise<{ relays: RelayInfo[]; timestamp: number } | null> {
    return this.fetchRelayKind(pubkey, 10002, bootstrapRelays, event =>
      this.parseRelayListEvent(event)
    );
  }

  /**
   * Fetch user's DM inbox relay list (kind:10050) from bootstrap relays
   */
  public async fetchDMRelayList(
    pubkey: string,
    bootstrapRelays: string[]
  ): Promise<{ relays: RelayInfo[]; timestamp: number } | null> {
    return this.fetchRelayKind(pubkey, 10050, bootstrapRelays, event =>
      this.parseInboxRelayEvent(event)
    );
  }

  /**
   * Publish a user's relay-list metadata event (kind:10002 NIP-65, or
   * kind:10050 NIP-17 inbox). Always broadcast via `publishEverywhere`
   * so the new list is findable on every relay other clients query —
   * solves the bootstrap problem when the user switches their write-
   * relay set: the new kind:10002 ends up on aggregator + indexer
   * relays even though the user only wrote it locally. Without this
   * the change would be invisible to anyone not already polling the
   * user's new write-set.
   */
  public async publishRelayList(
    relays: RelayInfo[],
    event: NostrEvent
  ): Promise<void> {
    this.systemLogger.info(
      'RelayListOrchestrator',
      `Publishing relay list (${relays.length} relays)`
    );

    try {
      await this.transport.publishEverywhere(event);
      this.systemLogger.info(
        'RelayListOrchestrator',
        `✓ Relay list published successfully`
      );
    } catch (error) {
      this.systemLogger.error(
        'RelayListOrchestrator',
        `Publish relay list failed: ${error}`
      );
      throw error;
    }
  }

  /**
   * Parse kind:10002 event into RelayInfo[]
   * NIP-65 format: [["r", url], ["r", url, "read"], ["r", url, "write"]]
   */
  private parseRelayListEvent(event: NostrEvent): RelayInfo[] {
    return event.tags
      .filter(
        (tag): tag is [string, string, ...string[]] =>
          tag[0] === 'r' && !!tag[1]
      )
      .map(tag => {
        const marker = tag[2];
        let types: RelayType[];
        if (marker === 'read') {
          types = ['read'];
        } else if (marker === 'write') {
          types = ['write'];
        } else {
          types = ['read', 'write'];
        }

        return {
          url: tag[1],
          types,
          isPaid: false,
          requiresAuth: false,
          isActive: true,
        };
      });
  }

  /**
   * Parse kind:10050 event into RelayInfo[]
   * NIP-17 format: [["relay", url], ["relay", url], ...]
   */
  private parseInboxRelayEvent(event: NostrEvent): RelayInfo[] {
    return event.tags
      .filter(
        (tag): tag is [string, string, ...string[]] =>
          tag[0] === 'relay' && !!tag[1]
      )
      .map(tag => ({
        url: tag[1],
        types: ['inbox'] as RelayType[],
        isPaid: false,
        requiresAuth: false,
        isActive: true,
      }));
  }

  /**
   * Convert RelayInfo[] to NIP-65 relay tags
   * Returns: [["r", url], ["r", url, "read"], ["r", url, "write"]]
   */
  public static relayInfosToTags(relays: RelayInfo[]): string[][] {
    return relays
      .filter(
        relay => relay.types.includes('read') || relay.types.includes('write')
      )
      .map(relay => {
        const hasRead = relay.types.includes('read');
        const hasWrite = relay.types.includes('write');

        if (hasRead && hasWrite) {
          return ['r', relay.url];
        } else if (hasRead) {
          return ['r', relay.url, 'read'];
        } else {
          return ['r', relay.url, 'write'];
        }
      });
  }

  // Orchestrator interface implementations

  public onui(_data: any): void {
    // Handle UI actions (future: relay status updates)
  }

  public onopen(_relay: string): void {
    // Silent operation
  }

  public onmessage(_relay: string, _event: NostrEvent): void {
    // Handle incoming events (future: relay list update subscriptions)
  }

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error(
      'RelayListOrchestrator',
      `Relay error (${relay}): ${error.message}`
    );
  }

  public onclose(_relay: string): void {
    // Silent operation
  }

  public override destroy(): void {
    super.destroy();
    this.systemLogger.info('RelayListOrchestrator', 'Destroyed');
  }
}
