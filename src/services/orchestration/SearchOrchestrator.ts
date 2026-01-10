/**
 * @orchestrator SearchOrchestrator
 * @purpose Handle NIP-50 full-text search queries across search relays
 * @used-by URLNavigationModal, GlobalSearchView
 */

import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../../components/system/SystemLogger';
import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';

/** Search relay endpoints (hardcoded + user relays) */
const SEARCH_RELAYS = [
  'wss://search.nos.today'
];

export interface SearchOptions {
  query: string;
  limit?: number;
  authors?: string[]; // Filter by specific authors (hex pubkeys)
  extensions?: {
    domain?: string;
    language?: string;
    sentiment?: 'negative' | 'neutral' | 'positive';
    nsfw?: boolean;
    includeSpam?: boolean;
  };
}

export class SearchOrchestrator extends Orchestrator {
  private static instance: SearchOrchestrator;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  private constructor() {
    super('SearchOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): SearchOrchestrator {
    if (!SearchOrchestrator.instance) {
      SearchOrchestrator.instance = new SearchOrchestrator();
    }
    return SearchOrchestrator.instance;
  }

  /**
   * Handle UI-triggered actions (not used for search - direct API calls)
   */
  public onui(_data: any): void {
    // Search is triggered via direct API calls (search/searchPaginated)
    // No UI event handling needed
  }

  /**
   * Handle relay connection opened
   */
  public onopen(_relay: string): void {
    // Search doesn't maintain persistent connections
  }

  /**
   * Handle incoming Nostr event
   */
  public onmessage(_relay: string, _event: NostrEvent): void {
    // Search uses fetch() not subscribe(), events handled directly in search methods
  }

  /**
   * Handle relay error
   */
  public onerror(relay: string, error: Error): void {
    this.systemLogger.error('SearchOrchestrator', `Relay error: ${relay}`, error.message);
  }

  /**
   * Handle relay connection closed
   */
  public onclose(_relay: string): void {
    // Search doesn't maintain persistent connections
  }

  /**
   * Perform full-text search using NIP-50
   */
  public async search(options: SearchOptions): Promise<NostrEvent[]> {
    const { query, limit = 20, authors, extensions } = options;

    // Build search filter (NIP-50)
    const filter: NDKFilter = {
      kinds: [1], // Only short text notes
      limit
    };

    // Add authors filter if provided
    if (authors && authors.length > 0) {
      filter.authors = authors;
    }

    // Build search string with extensions
    let searchString = query;

    if (extensions) {
      if (extensions.domain) {
        searchString += ` domain:${extensions.domain}`;
      }
      if (extensions.language) {
        searchString += ` language:${extensions.language}`;
      }
      if (extensions.sentiment) {
        searchString += ` sentiment:${extensions.sentiment}`;
      }
      if (extensions.nsfw !== undefined) {
        searchString += ` nsfw:${extensions.nsfw}`;
      }
      if (extensions.includeSpam) {
        searchString += ` include:spam`;
      }
    }

    // @ts-ignore - NIP-50 search field (not in nostr-tools types yet)
    filter.search = searchString;

    // Get search relays (hardcoded + user relays)
    const searchRelays = this.getSearchRelays();

    const firstAuthor = authors?.[0];
    const authorInfo = firstAuthor ? ` (author: ${firstAuthor.slice(0, 8)}...)` : '';
    this.systemLogger.info('SearchOrchestrator', `🔍 Searching for: "${query}"${authorInfo} on ${searchRelays.length} relays`);

    // Fetch events from search relays
    const events = await this.transport.fetch(searchRelays, [filter]);

    this.systemLogger.info('SearchOrchestrator', `✓ Found ${events.length} results`);

    return events;
  }

  /**
   * Get search relays (hardcoded + user relays)
   */
  private getSearchRelays(): string[] {
    const userRelays = this.relayConfig.getReadRelays();

    // Combine and deduplicate
    const allRelays = [...SEARCH_RELAYS, ...userRelays];
    return [...new Set(allRelays)];
  }

  /**
   * Search with pagination (for InfiniteScroll)
   */
  public async searchPaginated(
    options: SearchOptions,
    until?: number
  ): Promise<NostrEvent[]> {
    const filter: NDKFilter = {
      kinds: [1],
      limit: options.limit || 20
    };

    if (until) {
      filter.until = until;
    }

    // Add authors filter if provided
    if (options.authors && options.authors.length > 0) {
      filter.authors = options.authors;
    }

    // Build search string
    let searchString = options.query;
    if (options.extensions) {
      // Add extensions (same as above)
      const { domain, language, sentiment, nsfw, includeSpam } = options.extensions;
      if (domain) searchString += ` domain:${domain}`;
      if (language) searchString += ` language:${language}`;
      if (sentiment) searchString += ` sentiment:${sentiment}`;
      if (nsfw !== undefined) searchString += ` nsfw:${nsfw}`;
      if (includeSpam) searchString += ` include:spam`;
    }

    // @ts-ignore
    filter.search = searchString;

    const searchRelays = this.getSearchRelays();
    const events = await this.transport.fetch(searchRelays, [filter]);

    return events;
  }

  /**
   * Search for user profiles using NIP-50 (kind:0 metadata)
   * Returns parsed profile objects
   */
  public async searchProfiles(query: string, limit: number = 10): Promise<ProfileSearchResult[]> {
    if (!query || query.length < 2) {
      return [];
    }

    const filter: NDKFilter = {
      kinds: [0], // Profile metadata
      limit
    };

    // @ts-ignore - NIP-50 search field
    filter.search = query;

    const searchRelays = this.getSearchRelays();

    this.systemLogger.info('SearchOrchestrator', `🔍 Searching profiles for: "${query}"`);

    try {
      const events = await this.transport.fetch(searchRelays, [filter], 5000);

      // Parse profile events
      const profiles: ProfileSearchResult[] = [];
      for (const event of events) {
        try {
          const metadata = JSON.parse(event.content);
          profiles.push({
            pubkey: event.pubkey,
            name: metadata.name,
            display_name: metadata.display_name,
            picture: metadata.picture,
            nip05: metadata.nip05,
            about: metadata.about
          });
        } catch {
          // Skip invalid profile JSON
        }
      }

      this.systemLogger.info('SearchOrchestrator', `✓ Found ${profiles.length} profiles`);
      return profiles;
    } catch (error) {
      this.systemLogger.error('SearchOrchestrator', `Profile search failed: ${error}`);
      return [];
    }
  }
}

/** Profile search result (subset of full profile) */
export interface ProfileSearchResult {
  pubkey: string;
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  about?: string;
}
