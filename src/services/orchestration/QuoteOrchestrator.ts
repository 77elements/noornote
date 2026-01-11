/**
 * QuoteOrchestrator - Quoted Event Fetching
 * Handles fetching quoted events by reference
 *
 * @orchestrator QuoteOrchestrator
 * @purpose Fetch quoted events from nostr references (nostr:note, nostr:nevent, nostr:naddr, etc.)
 * @used-by QuoteNoteFetcher, QuotedNoteRenderer
 *
 * Architecture:
 * - Fetches events by ID (note, nevent, hex)
 * - Delegates addressable events (naddr) to LongFormOrchestrator
 * - Uses NoteService cache (cache-first, then relay fetch)
 * - Three-stage fetch: cache → standard relays → outbound relays fallback
 * - Silent logging (only errors)
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { decodeNip19 } from '../NostrToolsAdapter';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { LongFormOrchestrator } from './LongFormOrchestrator';
import { NoteService } from '../NoteService';
import { SystemLogger } from '../../components/system/SystemLogger';

export class QuoteOrchestrator extends Orchestrator {
  private static instance: QuoteOrchestrator;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private longFormOrch: LongFormOrchestrator;
  private noteService: NoteService;
  private systemLogger: SystemLogger;

  /** In-flight fetches to prevent duplicate requests */
  private fetchingQuotes: Map<string, Promise<NostrEvent | null>> = new Map();

  private constructor() {
    super('QuoteOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.longFormOrch = LongFormOrchestrator.getInstance();
    this.noteService = NoteService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): QuoteOrchestrator {
    if (!QuoteOrchestrator.instance) {
      QuoteOrchestrator.instance = new QuoteOrchestrator();
    }
    return QuoteOrchestrator.instance;
  }

  /**
   * Fetch quoted event from nostr reference
   * Handles: nostr:note1..., nostr:nevent1..., nostr:naddr1..., hex event IDs
   * @param nostrRef - Nostr reference string
   * @returns Event or null if not found
   */
  public async fetchQuotedEvent(nostrRef: string): Promise<NostrEvent | null> {
    // If already fetching, wait for that request (deduplication)
    if (this.fetchingQuotes.has(nostrRef)) {
      return await this.fetchingQuotes.get(nostrRef)!;
    }

    // Check if this is an naddr (addressable event)
    if (this.isNaddrReference(nostrRef)) {
      // Delegate to LongFormOrchestrator
      const fetchPromise = this.longFormOrch.fetchAddressableEvent(nostrRef);
      this.fetchingQuotes.set(nostrRef, fetchPromise);

      try {
        return await fetchPromise;
      } finally {
        this.fetchingQuotes.delete(nostrRef);
      }
    }

    // Extract event ID and relay hints from reference (note, nevent, hex)
    const { eventId, relayHints } = this.extractEventIdAndHints(nostrRef);
    if (!eventId) {
      this.systemLogger.error('QuoteOrchestrator', `Invalid reference format: ${nostrRef.slice(0, 20)}...`);
      return null;
    }

    // Start new fetch with relay hints
    const fetchPromise = this.fetchEventById(eventId, relayHints);
    this.fetchingQuotes.set(nostrRef, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.fetchingQuotes.delete(nostrRef);
    }
  }

  /**
   * Check if reference is an naddr (addressable event)
   */
  private isNaddrReference(nostrRef: string): boolean {
    try {
      const cleanRef = nostrRef.replace(/^nostr:/, '');
      const decoded = decodeNip19(cleanRef);
      return decoded.type === 'naddr';
    } catch {
      return false;
    }
  }

  /**
   * Extract event ID and relay hints from different nostr reference types
   * Supports: note1, nevent1, hex event IDs
   * Returns relay hints from nevent for priority fetching
   */
  private extractEventIdAndHints(nostrRef: string): { eventId: string | null; relayHints: string[] } {
    try {
      // Remove nostr: prefix if present
      const cleanRef = nostrRef.replace(/^nostr:/, '');

      // Try bech32 decoding first (note1, nevent1)
      try {
        const decoded = decodeNip19(cleanRef);

        switch (decoded.type) {
          case 'note':
            return { eventId: decoded.data as string, relayHints: [] };
          case 'nevent': {
            const neventData = decoded.data as { id: string; relays?: string[]; author?: string };
            return {
              eventId: neventData.id,
              relayHints: neventData.relays || []
            };
          }
          default:
            break;
        }
      } catch {
        // Not bech32, continue to hex check
      }

      // Check if it's already a hex event ID (64 chars)
      if (cleanRef.match(/^[a-f0-9]{64}$/)) {
        return { eventId: cleanRef, relayHints: [] };
      }

      return { eventId: null, relayHints: [] };

    } catch (error) {
      this.systemLogger.error('QuoteOrchestrator', `Extract ID error: ${error}`);
      return { eventId: null, relayHints: [] };
    }
  }

  /**
   * Fetch event by ID with four-stage strategy
   * Stage 0: Check NoteService cache first
   * Stage 1: Try relay hints (from nevent)
   * Stage 2: Try standard relays
   * Stage 3: If not found, try standard + outbound relays
   */
  private async fetchEventById(eventId: string, relayHints: string[] = []): Promise<NostrEvent | null> {
    // Stage 0: Check NoteService cache first
    const cached = this.noteService.getCachedNote(eventId);
    if (cached) {
      return cached;
    }

    const filter: NDKFilter = {
      ids: [eventId],
      limit: 1
    };

    // Stage 1: Try relay hints first (highest priority)
    if (relayHints.length > 0) {
      try {
        const events = await this.transport.fetch(relayHints, [filter], 5000);
        const event = events[0];
        if (event) {
          this.noteService.registerNote(event);
          return event;
        }
      } catch (error) {
        this.systemLogger.warn('QuoteOrchestrator', `Relay hints fetch failed: ${error}`);
      }
    }

    // Stage 2: Try standard relays
    const standardRelays = this.transport.getReadRelays();

    try {
      const events = await this.transport.fetch(standardRelays, [filter], 5000);
      const event = events[0];
      if (event) {
        this.noteService.registerNote(event);
        return event;
      }
    } catch (error) {
      this.systemLogger.error('QuoteOrchestrator', `Stage 2 fetch failed: ${error}`);
    }

    // Stage 3: Not found on standard relays, try with outbound relays
    try {
      const outboundRelays = await this.relayDiscovery.getCombinedRelays([], true);

      const events = await this.transport.fetch(outboundRelays, [filter], 10000);
      const event = events[0];
      if (event) {
        this.noteService.registerNote(event);
        return event;
      }
    } catch (error) {
      this.systemLogger.error('QuoteOrchestrator', `Stage 3 fetch failed: ${error}`);
    }

    return null;
  }

  // Orchestrator interface implementations (required by base class)

  public onui(_data: any): void {
    // Handle UI actions (future: manual quote refresh)
  }

  public onopen(_relay: string): void {
    // Silent operation
  }

  public onmessage(_relay: string, _event: NostrEvent): void {
    // Handle incoming events from subscriptions (future: live quote updates)
  }

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error('QuoteOrchestrator', `Relay error (${relay}): ${error.message}`);
  }

  public onclose(_relay: string): void {
    // Silent operation
  }

  public override destroy(): void {
    this.fetchingQuotes.clear();
    super.destroy();
  }
}
