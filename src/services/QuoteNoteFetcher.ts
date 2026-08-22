/**
 * Quote Note Fetcher
 * Wrapper service for QuoteOrchestrator
 * Provides backward-compatible API for fetching quoted events
 * Delegates to QuoteOrchestrator for orchestrator architecture compliance
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { QuoteOrchestrator } from './orchestration/QuoteOrchestrator';

export type QuoteFetchError =
  | { type: 'not_found'; message: string; eventId: string }
  | { type: 'network'; message: string; canRetry: true }
  | { type: 'parse'; message: string; reference: string }
  | { type: 'unknown'; message: string };

export type QuoteFetchResult =
  | { success: true; event: NostrEvent }
  | { success: false; error: QuoteFetchError };

export class QuoteNoteFetcher {
  private static instance: QuoteNoteFetcher;
  private orchestrator: QuoteOrchestrator;

  private constructor() {
    this.orchestrator = QuoteOrchestrator.getInstance();
  }

  public static getInstance(): QuoteNoteFetcher {
    if (!QuoteNoteFetcher.instance) {
      QuoteNoteFetcher.instance = new QuoteNoteFetcher();
    }
    return QuoteNoteFetcher.instance;
  }

  /**
   * Fetch event from nostr reference (delegates to QuoteOrchestrator).
   * @param parentAuthorPubkey - The pubkey of the note that CONTAINS this
   *        quote, NOT the quoted event's own author. Passed as an extra
   *        outbound-fallback candidate so cross-relay quotes resolve via
   *        the quoter's relays when the quoted author's relays don't carry
   *        the original.
   * @param outboundOnly - Skip stages 1, 2 and 2.5 (cache + outbound only).
   *        Used by the renderer's retry path after the first attempt proved
   *        the user's read set carries nothing.
   */
  public async fetchQuotedEvent(
    nostrRef: string,
    parentAuthorPubkey?: string,
    outboundOnly: boolean = false
  ): Promise<NostrEvent | null> {
    return this.orchestrator.fetchQuotedEvent(
      nostrRef,
      undefined,
      parentAuthorPubkey ? [parentAuthorPubkey] : [],
      outboundOnly
    );
  }

  /**
   * Fetch event with detailed error result (delegates to QuoteOrchestrator).
   * `parentAuthorPubkey` see {@link fetchQuotedEvent}.
   * `outboundOnly` see {@link fetchQuotedEvent}.
   */
  public async fetchQuotedEventWithError(
    nostrRef: string,
    parentAuthorPubkey?: string,
    outboundOnly: boolean = false
  ): Promise<QuoteFetchResult> {
    try {
      const event = await this.orchestrator.fetchQuotedEvent(
        nostrRef,
        undefined,
        parentAuthorPubkey ? [parentAuthorPubkey] : [],
        outboundOnly
      );

      if (event) {
        return { success: true, event };
      }

      // Not found
      return {
        success: false,
        error: {
          type: 'not_found',
          message: 'Note not found on any relays',
          eventId: nostrRef.slice(0, 12),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          type: 'network',
          message: 'Failed to connect to relays',
          canRetry: true,
        },
      };
    }
  }

  /**
   * Clear cache (no-op: QuoteOrchestrator has no cache)
   */
  public clearCache(): void {
    // QuoteOrchestrator does not cache - always fetches fresh
  }
}
