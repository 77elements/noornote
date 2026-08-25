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
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { decodeNip19 } from '../NostrToolsAdapter';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { LongFormOrchestrator } from './LongFormOrchestrator';
import { NoteService } from '../NoteService';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../SystemLogger';
import { diagLog } from '../DiagnosticLogger';

export class QuoteOrchestrator extends Orchestrator {
  private static instance: QuoteOrchestrator;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private longFormOrch: LongFormOrchestrator;
  private noteService: NoteService;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  /** In-flight fetches to prevent duplicate requests */
  private fetchingQuotes: Map<string, Promise<NostrEvent | null>> = new Map();

  private constructor() {
    super('QuoteOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.longFormOrch = LongFormOrchestrator.getInstance();
    this.noteService = NoteService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
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
   * @param authorHint - Optional author pubkey (hex) of the quoted event itself,
   *                    used for outbound resolution when the reference doesn't
   *                    carry author info (e.g. raw hex IDs / bare note1).
   *                    nevent's embedded author takes precedence over this hint.
   * @param extraOutboundPubkeys - Additional pubkeys to include in stage-3
   *                    outbound fallback. Typically the PARENT note's author
   *                    (the user who quoted/reposted), since they obviously
   *                    saw the original on some relay and that relay is the
   *                    best next guess after the quoted-event-author's own
   *                    outbound. Without this hop, cross-relay quotes (the
   *                    quoter's read set vs. the quoted author's write set
   *                    don't intersect) collapse to "Note not found".
   * @param outboundOnly - Skip stages 1, 2 and 2.5 and go straight to
   *                    Stage 0 (cache) + Stage 3 (outbound, 15s timeout).
   *                    Used by the QuotedNoteRenderer's retry path: the
   *                    initial attempt already proved the user's read set
   *                    and the indexer set don't carry the note (cold or
   *                    EOSE-empty), so a retry should only spend time on
   *                    the now-warm outbound relays where the note actually
   *                    lives (e.g. a bridge relay the quoter used).
   * @returns Event or null if not found
   */
  public async fetchQuotedEvent(
    nostrRef: string,
    authorHint?: string,
    extraOutboundPubkeys: string[] = [],
    outboundOnly: boolean = false
  ): Promise<NostrEvent | null> {
    // If already fetching, wait for that request (deduplication).
    // NOTE: outboundOnly retries intentionally bypass dedup — they must run
    // even while an earlier normal fetch is in-flight, otherwise the retry
    // would silently return the same (still-pending or already-null) promise
    // and never reach Stage 3 with warm relays.
    if (!outboundOnly && this.fetchingQuotes.has(nostrRef)) {
      return this.fetchingQuotes.get(nostrRef)!;
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

    // Extract event ID, relay hints, and author from reference (note, nevent, hex)
    const {
      eventId,
      relayHints,
      author: extractedAuthor,
    } = this.extractEventIdAndHints(nostrRef);
    if (!eventId) {
      this.systemLogger.error(
        'QuoteOrchestrator',
        `Invalid reference format: ${nostrRef.slice(0, 20)}...`
      );
      return null;
    }

    // Prefer the author embedded in the reference (nevent.author) over the
    // caller-supplied hint, since the reference itself is authoritative.
    const author = extractedAuthor || authorHint || null;

    // Start new fetch with relay hints and author for outbound relay discovery
    const fetchPromise = this.fetchEventById(
      eventId,
      relayHints,
      author,
      extraOutboundPubkeys,
      outboundOnly
    );
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
  private extractEventIdAndHints(nostrRef: string): {
    eventId: string | null;
    relayHints: string[];
    author: string | null;
  } {
    try {
      // Remove nostr: prefix if present
      const cleanRef = nostrRef.replace(/^nostr:/, '');

      // Try bech32 decoding first (note1, nevent1)
      // If checksum fails, retry with last char trimmed (some clients emit off-by-one bech32)
      for (const ref of [cleanRef, cleanRef.slice(0, -1)]) {
        try {
          const decoded = decodeNip19(ref);

          switch (decoded.type) {
            case 'note':
              return {
                eventId: decoded.data as string,
                relayHints: [],
                author: null,
              };
            case 'nevent': {
              const neventData = decoded.data as {
                id: string;
                relays?: string[];
                author?: string;
              };
              return {
                eventId: neventData.id,
                relayHints: neventData.relays || [],
                author: neventData.author || null,
              };
            }
            default:
              break;
          }
        } catch {
          // Try next variant or fall through to hex check
        }
      }

      // Check if it's already a hex event ID (64 chars)
      if (cleanRef.match(/^[a-f0-9]{64}$/)) {
        return { eventId: cleanRef, relayHints: [], author: null };
      }

      return { eventId: null, relayHints: [], author: null };
    } catch (error) {
      this.systemLogger.error(
        'QuoteOrchestrator',
        `Extract ID error: ${String(error)}`
      );
      return { eventId: null, relayHints: [], author: null };
    }
  }

  /**
   * Fetch event by ID with four-stage strategy
   * Stage 0: Check NoteService cache first
   * Stage 1: Try relay hints (from nevent)
   * Stage 2: Try standard relays
   * Stage 2.5: Try metadata / indexer relays (broadly-replicated events, e.g.
   *         zap receipts that don't live on the user's read relays)
   * Stage 3: If not found, try outbound relays of EVERY known relevant pubkey
   *         (quoted event's author + the parent-note author / reposter that
   *         pulled it onto our radar in the first place).
   *
   * @param outboundOnly Skip stages 1, 2 and 2.5 — go straight from cache to
   *        Stage 3 (outbound) with a longer timeout (15s). Used by retry path
   *        where earlier stages already proved empty.
   */
  private async fetchEventById(
    eventId: string,
    relayHints: string[] = [],
    author: string | null = null,
    extraOutboundPubkeys: string[] = [],
    outboundOnly: boolean = false
  ): Promise<NostrEvent | null> {
    const shortId = eventId.slice(0, 8);

    // Stage 0: Check NoteService cache first (always — cache may have filled
    // since the previous attempt via a feed subscription or a parallel fetch).
    const cached = this.noteService.getCachedNote(eventId);
    if (cached) {
      return cached;
    }

    const filter: NDKFilter = { ids: [eventId], limit: 1 };

    // Stages 1, 2 and 2.5 are skipped on the retry path: they were just
    // walked through with cold / EOSE-empty results, re-running them only
    // burns the same timeouts again. Stage 3 (outbound) is the one whose
    // relays are now warm — that's where the retry should spend its budget.
    if (!outboundOnly) {
      // Stage 1: Try relay hints first (highest priority)
      if (relayHints.length > 0) {
        try {
          const events = await this.transport.fetch(
            relayHints,
            [filter],
            5000,
            false,
            'QuoteOrch'
          );
          if (events[0]) {
            this.noteService.registerNote(events[0]);
            return events[0];
          }
        } catch (error) {
          diagLog('relays', 'QuoteOrchestrator: stage 1 (hints) failed', {
            eventId: shortId,
            error: String(error),
          });
        }
      }

      // Stage 2: Try standard relays
      try {
        const events = await this.transport.fetch(
          this.transport.getReadRelays(),
          [filter],
          5000,
          false,
          'QuoteOrch'
        );
        if (events[0]) {
          this.noteService.registerNote(events[0]);
          return events[0];
        }
      } catch (error) {
        diagLog('relays', 'QuoteOrchestrator: stage 2 (standard) failed', {
          eventId: shortId,
          error: String(error),
        });
      }

      // Stage 2.5: Try metadata / indexer relays (nostr.band & co). These index
      // widely-replicated events the user's own read relays often don't carry —
      // notably zap receipts (kind 9735), whose home is the recipient's / zap
      // request's relays, not ours. skipCache=true forces a relay-only fetch.
      try {
        const standardSet = new Set(this.transport.getReadRelays());
        const indexerRelays = this.relayConfig
          .getMetadataRelays()
          .filter(r => !standardSet.has(r));
        if (indexerRelays.length > 0) {
          const events = await this.transport.fetch(
            indexerRelays,
            [filter],
            6000,
            true,
            'QuoteOrch'
          );
          if (events[0]) {
            diagLog(
              'relays',
              'QuoteOrchestrator: indexer fallback found quote',
              { eventId: shortId }
            );
            this.noteService.registerNote(events[0]);
            return events[0];
          }
        }
      } catch (error) {
        diagLog('relays', 'QuoteOrchestrator: stage 2.5 (indexer) failed', {
          eventId: shortId,
          error: String(error),
        });
      }
    }

    // Stage 3: Not found on standard relays, try with outbound relays
    // skipCache=true forces relay-only fetch (bypasses NDK cache from stage 2)
    // Union of (quoted-event author, parent-note author / reposter) — both are
    // legitimate "who saw this note" signals and either's outbound is a
    // better next guess than just one of them.
    const outboundPubkeys = Array.from(
      new Set([author, ...extraOutboundPubkeys].filter((p): p is string => !!p))
    );
    if (outboundPubkeys.length > 0) {
      try {
        const outboundRelays = await this.relayDiscovery.getCombinedRelays(
          outboundPubkeys,
          true
        );
        const standardRelays = new Set(this.transport.getReadRelays());
        const newRelays = outboundRelays.filter(r => !standardRelays.has(r));
        // Retry path: longer timeout — outbound relays (especially a bridge
        // relay like mostr.pub the quoter used) often need extra seconds on
        // their first connection of the session. 15s empirically covers the
        // tail of the slow-EOSE distribution we see in the relays logs.
        const stageTimeout = outboundOnly ? 15000 : 10000;
        diagLog('relays', 'QuoteOrchestrator: stage 3 trying outbound', {
          eventId: shortId,
          pubkeys: outboundPubkeys.map(p => p.slice(0, 8)),
          relayCount: outboundRelays.length,
          newRelays: newRelays.slice(0, 5),
          outboundOnly,
        });

        const events = await this.transport.fetch(
          outboundRelays,
          [filter],
          stageTimeout,
          true,
          'QuoteOrch'
        );
        if (events[0]) {
          diagLog(
            'relays',
            'QuoteOrchestrator: outbound fallback found quote',
            { eventId: shortId, outboundOnly }
          );
          this.noteService.registerNote(events[0]);
          return events[0];
        }
        diagLog('relays', 'QuoteOrchestrator: stage 3 returned empty', {
          eventId: shortId,
          relayCount: outboundRelays.length,
          outboundOnly,
        });
      } catch (error) {
        diagLog('relays', 'QuoteOrchestrator: stage 3 (outbound) failed', {
          eventId: shortId,
          error: String(error),
          outboundOnly,
        });
      }
    } else {
      diagLog('relays', 'QuoteOrchestrator: no pubkeys for outbound fallback', {
        eventId: shortId,
        outboundOnly,
      });
    }

    diagLog('relays', 'QuoteOrchestrator: NOT FOUND after all stages', {
      eventId: shortId,
      outboundPubkeyCount: outboundPubkeys.length,
      hasHints: relayHints.length > 0,
      outboundOnly,
    });
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
    this.systemLogger.error(
      'QuoteOrchestrator',
      `Relay error (${relay}): ${error.message}`
    );
  }

  public onclose(_relay: string): void {
    // Silent operation
  }

  public override destroy(): void {
    this.fetchingQuotes.clear();
    super.destroy();
  }
}
