/**
 * @orchestrator PollOrchestrator
 * @purpose Fetch and aggregate poll results (NIP-88 kind:1018 responses)
 * @used-by NoteUI, QuotedNoteRenderer
 *
 * Responsibilities:
 * - Fetch poll responses (kind:1018) for poll events (kind:1068)
 * - Aggregate votes per option (1 vote per pubkey, most recent counts)
 * - Support singlechoice and multiplechoice polls
 * - Cache results with 5min TTL
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';

interface PollOptionInput {
  id: string;
  label: string;
}

interface PollOptionResult {
  id: string;
  label: string;
  voteCount: number;
}

interface PollResults {
  options: PollOptionResult[];
  totalVotes: number; // Total unique voters
  userVote: string | null; // Current user's vote (option ID), if any
  timestamp: number;
}

export class PollOrchestrator extends Orchestrator {
  private static instance: PollOrchestrator;
  private transport: NostrTransport;
  private resultsCache: Map<string, PollResults> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    super('PollOrchestrator');
    this.transport = NostrTransport.getInstance();
  }

  public static getInstance(): PollOrchestrator {
    if (!PollOrchestrator.instance) {
      PollOrchestrator.instance = new PollOrchestrator();
    }
    return PollOrchestrator.instance;
  }

  /**
   * Fetch poll results for a given poll event (NIP-88)
   * Returns cached results if available and fresh
   * @param pollEventId - ID of the kind:1068 poll event
   * @param pollOptions - Poll options from the poll event
   * @param currentUserPubkey - Current user's pubkey (optional, to check if they voted)
   */
  public async fetchPollResults(
    pollEventId: string,
    pollOptions: PollOptionInput[],
    currentUserPubkey?: string
  ): Promise<PollResults> {
    // Check cache first
    const cached = this.resultsCache.get(pollEventId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached;
    }

    // Fetch poll responses (kind:1018) for this poll
    const responses = await this.fetchPollResponses(pollEventId);

    // Aggregate votes (1 vote per pubkey, most recent counts)
    const results = this.aggregateVotes(responses, pollOptions, currentUserPubkey);
    results.timestamp = Date.now();

    // Cache results
    this.resultsCache.set(pollEventId, results);

    return results;
  }

  /**
   * Fetch poll responses (kind:1018) for a poll event (NIP-88)
   */
  private async fetchPollResponses(pollEventId: string): Promise<NostrEvent[]> {
    const relays = this.transport.getReadRelays();
    const filter = {
      kinds: [1018],
      '#e': [pollEventId],
      limit: 1000 // Fetch up to 1000 responses
    };

    const events = await this.transport.fetch(relays, [filter], 5000, false, 'PollOrch');
    return events;
  }

  /**
   * Aggregate votes from poll responses (NIP-88)
   * Rules:
   * - 1 vote per pubkey (most recent response counts)
   * - singlechoice: First 'response' tag is the vote
   * - multiplechoice: All 'response' tags count
   */
  private aggregateVotes(
    responses: NostrEvent[],
    pollOptions: PollOptionInput[],
    currentUserPubkey?: string
  ): PollResults {
    // Initialize vote counts
    const voteCounts = new Map<string, number>();
    pollOptions.forEach(opt => {
      voteCounts.set(opt.id, 0);
    });

    // Track most recent response per pubkey
    const latestResponsePerPubkey = new Map<string, NostrEvent>();

    // Find most recent response for each pubkey
    for (const response of responses) {
      const existing = latestResponsePerPubkey.get(response.pubkey);
      if (!existing || response.created_at > existing.created_at) {
        latestResponsePerPubkey.set(response.pubkey, response);
      }
    }

    // Count votes from latest responses
    let userVote: string | null = null;

    for (const [pubkey, response] of latestResponsePerPubkey.entries()) {
      // Extract 'response' tags
      const responseTags = response.tags.filter(t => t[0] === 'response' && t[1]);

      if (responseTags.length > 0) {
        // Increment vote count for each selected option
        responseTags.forEach(tag => {
          const optionId = tag[1];
          if (optionId) {
            const current = voteCounts.get(optionId);
            if (current !== undefined) {
              voteCounts.set(optionId, current + 1);
            }
          }
        });

        // Check if this is the current user's vote
        if (currentUserPubkey && pubkey === currentUserPubkey) {
          userVote = responseTags[0]?.[1] ?? null; // Store first response option
        }
      }
    }

    // Build results
    const options = pollOptions.map(opt => ({
      id: opt.id,
      label: opt.label,
      voteCount: voteCounts.get(opt.id) || 0
    }));

    return {
      options,
      totalVotes: latestResponsePerPubkey.size, // Unique voters
      userVote,
      timestamp: Date.now()
    };
  }

  /**
   * Clear cache for specific poll
   */
  public clearCache(pollEventId: string): void {
    this.resultsCache.delete(pollEventId);
  }

  /**
   * Clear all cached results
   */
  public clearAllCache(): void {
    this.resultsCache.clear();
  }

  // Orchestrator interface implementations (not used for polls, but required)
  public onui(_data: any): void {
    // Polls don't use router subscriptions, we fetch on-demand
  }

  public onopen(_relay: string): void {
    // No-op
  }

  public onmessage(_relay: string, _event: NostrEvent): void {
    // No-op - we fetch zaps directly, not via router
  }

  public onerror(_relay: string, _error: Error): void {
    // No-op
  }

  public onclose(_relay: string): void {
    // No-op
  }
}
