/**
 * MarketplaceFeedOrchestrator — Fetch & paginate NIP-99 listings (kind:30402)
 *
 * Cloned from ArticleFeedOrchestrator, adapted for marketplace.
 * Part of the Marketplace Add-On — only loaded when feature is enabled.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { Orchestrator } from '../../services/orchestration/Orchestrator';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { parseListingMetadata } from './marketplace-helpers';
import { RelayConfig } from '../../services/RelayConfig';
import { SystemLogger } from '../../components/system/SystemLogger';

export interface ListingFeedResult {
  listings: NostrEvent[];
  hasMore: boolean;
}

export class MarketplaceFeedOrchestrator extends Orchestrator {
  private static instance: MarketplaceFeedOrchestrator;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  private listingCache: Map<string, NostrEvent> = new Map();
  private oldestTimestamp: number = Math.floor(Date.now() / 1000);
  private readonly PAGE_SIZE = 20;

  private constructor() {
    super('MarketplaceFeedOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info('MarketplaceFeedOrchestrator', 'Initialized');
  }

  public static getInstance(): MarketplaceFeedOrchestrator {
    if (!MarketplaceFeedOrchestrator.instance) {
      MarketplaceFeedOrchestrator.instance = new MarketplaceFeedOrchestrator();
    }
    return MarketplaceFeedOrchestrator.instance;
  }

  public onui(_data: unknown): void {}
  public onopen(_relay: string): void {}
  public onmessage(_relay: string, _event: NostrEvent): void {}
  public onerror(_relay: string, _error: Error): void {}
  public onclose(_relay: string): void {}

  public async loadInitial(): Promise<ListingFeedResult> {
    this.reset();
    return this.fetchListings();
  }

  public async loadMore(): Promise<ListingFeedResult> {
    return this.fetchListings();
  }

  public reset(): void {
    this.oldestTimestamp = Math.floor(Date.now() / 1000);
    this.listingCache.clear();
  }

  private async fetchListings(): Promise<ListingFeedResult> {
    try {
      const relays = this.relayConfig.getReadRelays();

      if (relays.length === 0) {
        this.systemLogger.warn('MarketplaceFeedOrchestrator', 'No read relays configured');
        return { listings: [], hasMore: false };
      }

      const filter = {
        kinds: [30402 as number],
        until: this.oldestTimestamp,
        limit: this.PAGE_SIZE + 5
      };

      this.systemLogger.info(
        'MarketplaceFeedOrchestrator',
        `Fetching listings until ${new Date(this.oldestTimestamp * 1000).toISOString()}`
      );

      const events = await this.transport.fetch(relays, [filter], 8000);
      const uniqueListings = this.deduplicateListings(events)
        .filter(e => this.isValidListing(e));

      uniqueListings.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

      const hasMore = uniqueListings.length > this.PAGE_SIZE;
      const listingsToReturn = uniqueListings.slice(0, this.PAGE_SIZE);

      const oldest = listingsToReturn[listingsToReturn.length - 1];
      if (oldest) {
        this.oldestTimestamp = (oldest.created_at || 0) - 1;
      }

      listingsToReturn.forEach(listing => {
        const key = this.getListingKey(listing);
        this.listingCache.set(key, listing);
      });

      this.systemLogger.info(
        'MarketplaceFeedOrchestrator',
        `Fetched ${listingsToReturn.length} listings, hasMore: ${hasMore}`
      );

      return { listings: listingsToReturn, hasMore };
    } catch (error) {
      this.systemLogger.error('MarketplaceFeedOrchestrator', 'Failed to fetch listings:', error);
      return { listings: [], hasMore: false };
    }
  }

  private deduplicateListings(events: NostrEvent[]): NostrEvent[] {
    const listingMap = new Map<string, NostrEvent>();

    for (const event of events) {
      const key = this.getListingKey(event);
      const existing = listingMap.get(key);

      if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
        listingMap.set(key, event);
      }
    }

    return Array.from(listingMap.values());
  }

  private getListingKey(event: NostrEvent): string {
    const dTag = event.tags?.find(t => t[0] === 'd')?.[1] || '';
    return `${event.pubkey}:${dTag}`;
  }

  /** Filter out spam/test listings, image-less listings, and NSFW content */
  private isValidListing(event: NostrEvent): boolean {
    const title = event.tags?.find(t => t[0] === 'title')?.[1] || '';
    if (!title || title === 'Untitled Listing') return false;

    // Must have at least one image
    const meta = parseListingMetadata(event);
    if (meta.images.length === 0) return false;

    // NSFW check on title + content
    const searchText = `${title} ${event.content || ''}`.toLowerCase();
    if (NSFW_KEYWORDS.some(kw => searchText.includes(kw))) return false;

    // Explicit NSFW tag
    const nsfwTag = event.tags?.find(t => t[0] === 'nsfw')?.[1];
    if (nsfwTag === 'true' || nsfwTag === '1') return false;

    return true;
  }
}

/**
 * NSFW keyword filter list.
 * Listings containing any of these words in title or description are hidden.
 * All entries must be lowercase.
 */
const NSFW_KEYWORDS: string[] = [
  // Sexual content
  'nude', 'nudes', 'naked', 'porn', 'pornography', 'xxx',
  'sex', 'sexual', 'sexy', 'erotic', 'erotica',
  'fetish', 'bdsm', 'bondage', 'dominatrix',
  'escort', 'camgirl', 'camboy', 'onlyfans',
  'pantyhouse', 'pantyhose', 'lingerie',
  'stripper', 'striptease',
  'dildo', 'vibrator', 'fleshlight', 'butt plug',
  'hentai', 'ahegao', 'waifu',
  // Drugs
  'cocaine', 'heroin', 'meth', 'methamphetamine',
  'mdma', 'ecstasy', 'lsd', 'fentanyl',
  'drug dealer', 'narcotic',
  // Weapons
  'ghost gun', 'untraceable firearm',
  // Fraud
  'fake id', 'counterfeit', 'stolen credit',
  'carding', 'fullz', 'bank drop',
];
