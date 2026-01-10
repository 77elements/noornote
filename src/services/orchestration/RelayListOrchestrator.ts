/**
 * RelayListOrchestrator - NIP-65 Relay List Management
 * Handles fetching and publishing user's relay list (kind:10002)
 *
 * @orchestrator RelayListOrchestrator
 * @purpose Fetch and publish NIP-65 relay lists
 * @used-by RelayConfig, SettingsView
 *
 * Architecture:
 * - Fetches kind:10002 relay list metadata on LOGIN
 * - Publishes kind:10002 when user updates settings
 * - Bootstrap relays from config/relays.json used to fetch
 * - User's relay list syncs across devices
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { SystemLogger } from '../../components/system/SystemLogger';
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
   * Fetch user's relay list (kind:10002) from bootstrap relays
   * Called on LOGIN event
   */
  public async fetchRelayList(
    pubkey: string,
    bootstrapRelays: string[]
  ): Promise<RelayInfo[] | null> {
    // Silent operation - RelayConfig logs "Fetching [username]'s relay list"

    const filters: NDKFilter[] = [{
      authors: [pubkey],
      kinds: [10002],
      limit: 1
    }];

    try {
      const events = await this.transport.fetch(bootstrapRelays, filters, 5000);

      if (events.length === 0) {
        this.systemLogger.info(
          'RelayListOrchestrator',
          'No relay list found (kind:10002)'
        );
        return null;
      }

      // Parse most recent relay list
      const event = events[0];
      if (!event) return null;
      const relayInfos = this.parseRelayListEvent(event);

      // Silent operation - RelayConfig logs "✓ Loaded X relays from NIP-65"

      return relayInfos;
    } catch (error) {
      this.systemLogger.error(
        'RelayListOrchestrator',
        `Fetch relay list failed: ${error}`
      );
      return null;
    }
  }

  /**
   * Publish user's relay list (kind:10002) to publish relays
   */
  public async publishRelayList(
    relays: RelayInfo[],
    publishRelays: string[],
    event: NostrEvent
  ): Promise<void> {
    this.systemLogger.info(
      'RelayListOrchestrator',
      `Publishing relay list (${relays.length} relays)`
    );

    try {
      await this.transport.publish(publishRelays, event);
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
    const relayInfos: RelayInfo[] = [];

    event.tags.forEach(tag => {
      if (tag[0] === 'r' && tag[1]) {
        const url = tag[1];
        const marker = tag[2]; // "read", "write", or undefined (both)

        let types: RelayType[] = [];
        if (!marker) {
          // No marker = both read and write
          types = ['read', 'write'];
        } else if (marker === 'read') {
          types = ['read'];
        } else if (marker === 'write') {
          types = ['write'];
        }

        relayInfos.push({
          url,
          types,
          isPaid: false,
          requiresAuth: false,
          isActive: true
        });
      }
    });

    return relayInfos;
  }

  /**
   * Convert RelayInfo[] to NIP-65 relay tags
   * Returns: [["r", url], ["r", url, "read"], ["r", url, "write"]]
   */
  public static relayInfosToTags(relays: RelayInfo[]): string[][] {
    return relays.map(relay => {
      const hasRead = relay.types.includes('read');
      const hasWrite = relay.types.includes('write');

      if (hasRead && hasWrite) {
        // Both read and write = no marker
        return ['r', relay.url];
      } else if (hasRead) {
        return ['r', relay.url, 'read'];
      } else if (hasWrite) {
        return ['r', relay.url, 'write'];
      } else {
        // No types = both (fallback)
        return ['r', relay.url];
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
