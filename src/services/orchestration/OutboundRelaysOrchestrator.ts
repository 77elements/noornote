/**
 * OutboundRelaysOrchestrator - NIP-65 Multi-User Relay Discovery
 * Fetches relay lists from multiple users to discover "outbound relays"
 * for improved timeline diversity and content discovery
 *
 * @orchestrator OutboundRelaysOrchestrator
 * @purpose Discover additional relays from user's following list
 * @used-by FeedOrchestrator, QuoteOrchestrator, LongFormOrchestrator
 *
 * Architecture:
 * - Fetches kind:10002 relay lists for multiple users (following list)
 * - Aggregates write relays (where users publish content)
 * - Quality filtering to avoid local/test relays
 * - 24-hour cache TTL (relay lists are stable; persisted across sessions)
 * - Write-through IndexedDB persistence (shared cache, public data — not per-user)
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../SystemLogger';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';

export interface UserRelayList {
  pubkey: string;
  writeRelays: string[];
  readRelays: string[];
  lastUpdated: number;
}

const IDB_NAME = 'noornote_nip65_cache';
const IDB_VERSION = 1;
const IDB_STORE = 'relay_lists';

export interface RelayDiscoveryStats {
  totalUsers: number;
  discoveredRelays: number;
  cacheHits: number;
  cacheMisses: number;
}

export class OutboundRelaysOrchestrator extends Orchestrator {
  private static instance: OutboundRelaysOrchestrator;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000;
  private relayListCache = new LRUCache<UserRelayList>(getCacheSize(200, 100, 50), this.CACHE_TTL);
  private stats: RelayDiscoveryStats = {
    totalUsers: 0,
    discoveredRelays: 0,
    cacheHits: 0,
    cacheMisses: 0
  };
  private readonly LOG_TAG = 'OutboundRelaysOrchestrator';

  /**
   * Hydration promise for the IndexedDB warm-cache restore. Public methods
   * await this before reading the cache, so the first session lookup after
   * cold-start hits the persisted entries instead of forcing a relay round-trip.
   */
  private readonly restorePromise: Promise<void>;

  private constructor() {
    super('OutboundRelaysOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.restorePromise = this.restoreFromIDB();
    this.systemLogger.info(this.LOG_TAG, 'Initialized');
  }

  public static getInstance(): OutboundRelaysOrchestrator {
    if (!OutboundRelaysOrchestrator.instance) {
      OutboundRelaysOrchestrator.instance = new OutboundRelaysOrchestrator();
    }
    return OutboundRelaysOrchestrator.instance;
  }

  public async discoverUserRelays(pubkeys: string[]): Promise<UserRelayList[]> {
    // Block on first call until the IDB warm-cache has hydrated, so persisted
    // entries from prior sessions count as hits instead of forcing a refetch.
    await this.restorePromise;

    const baseRelays = this.relayConfig.getAggregatorRelays();
    const results: UserRelayList[] = [];
    const uncachedPubkeys: string[] = [];

    this.systemLogger.info(this.LOG_TAG, `Fetching relay lists for ${pubkeys.length} users`);

    for (const pubkey of pubkeys) {
      const cached = this.getCachedRelayList(pubkey);
      if (cached) {
        results.push(cached);
        this.stats.cacheHits++;
      } else {
        uncachedPubkeys.push(pubkey);
        this.stats.cacheMisses++;
      }
    }

    if (uncachedPubkeys.length === 0) {
      this.systemLogger.info(this.LOG_TAG, 'All relay lists found in cache');
      return results;
    }

    this.systemLogger.info(this.LOG_TAG, `Fetching ${uncachedPubkeys.length} uncached users`);

    const filter: NDKFilter = {
      authors: uncachedPubkeys,
      kinds: [10002],
      limit: uncachedPubkeys.length * 2
    };

    try {
      const events = await this.transport.fetch(baseRelays, [filter], 5000, false, 'OutboundOrch');
      this.systemLogger.info(this.LOG_TAG, `Received ${events.length} relay list events`);

      const processedPubkeys = new Set<string>();

      for (const event of events) {
        if (processedPubkeys.has(event.pubkey)) continue;

        const relayList = this.parseRelayListEvent(event);
        if (relayList) {
          results.push(relayList);
          this.cacheRelayList(relayList);
          processedPubkeys.add(event.pubkey);
        }
      }

      const aggregatorRelays = this.relayConfig.getAggregatorRelays();
      for (const pubkey of uncachedPubkeys) {
        if (!processedPubkeys.has(pubkey)) {
          const defaultRelayList: UserRelayList = {
            pubkey,
            writeRelays: aggregatorRelays,
            readRelays: aggregatorRelays,
            lastUpdated: Date.now()
          };
          results.push(defaultRelayList);
          this.cacheRelayList(defaultRelayList);
        }
      }

      this.stats.totalUsers = pubkeys.length;
      this.stats.discoveredRelays = results.reduce(
        (sum, list) => sum + list.writeRelays.length + list.readRelays.length,
        0
      );
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Fetch relay lists error: ${error}`);
    }

    return results;
  }

  public getOutboundRelays(userRelayLists: UserRelayList[]): string[] {
    const outboundRelays = new Set<string>();
    const baseRelays = new Set(this.relayConfig.getReadRelays());

    for (const relayList of userRelayLists) {
      for (const relay of relayList.writeRelays) {
        if (this.isValidRelay(relay) && !baseRelays.has(relay) && this.isQualityRelay(relay)) {
          outboundRelays.add(relay);
        }
      }
    }

    const result = Array.from(outboundRelays);
    this.systemLogger.info(this.LOG_TAG, `Discovered ${result.length} quality outbound relays from ${userRelayLists.length} users`);

    return result;
  }

  /**
   * Lean, author-centric relay set for a single profile's feed (ProfileView):
   * the author's own NIP-65 write relays, capped at 8, with the standard read
   * relays as fallback when discovery finds nothing. Deliberately excludes
   * aggregators and the current user's read relays — a single author publishes
   * to their own write relays, so this set is both smaller and more complete for
   * their history (used with the raw, gap-free direct fetch).
   */
  public async getProfileRelays(pubkey: string): Promise<string[]> {
    const relayLists = await this.discoverUserRelays([pubkey]);
    const writeRelays = Array.from(
      new Set(relayLists.flatMap((l) => l.writeRelays).filter((r) => this.isValidRelay(r)))
    ).slice(0, 8);

    // PV-DBG: temporary — shows the resolved relay set (and whether we fell back).
    console.log(`[PV-DBG] getProfileRelays ${pubkey.slice(0, 8)}: ${relayLists.length} lists, ${writeRelays.length} write relays: ${writeRelays.join(', ')}`);

    if (writeRelays.length === 0) {
      const fallback = this.relayConfig.getReadRelays();
      this.systemLogger.info(this.LOG_TAG, `Profile relays: none discovered, falling back to ${fallback.length} read relays`);
      console.log(`[PV-DBG] getProfileRelays ${pubkey.slice(0, 8)}: FALLBACK to ${fallback.length} read relays: ${fallback.join(', ')}`);
      return fallback;
    }

    this.systemLogger.info(this.LOG_TAG, `Profile relays: ${writeRelays.length} author write relays`);
    return writeRelays;
  }

  public async getCombinedRelays(pubkeys: string[], includeOutbound: boolean = true): Promise<string[]> {
    const standardRelays = this.relayConfig.getReadRelays();

    if (!includeOutbound) {
      this.systemLogger.info(this.LOG_TAG, `Using ${standardRelays.length} standard relays`);
      return standardRelays;
    }

    try {
      const relayLists = await this.discoverUserRelays(pubkeys);
      const outboundRelays = this.getOutboundRelays(relayLists);
      const aggregatorRelays = this.relayConfig.getAggregatorRelays();

      const combined = [...new Set([...standardRelays, ...outboundRelays, ...aggregatorRelays])];

      this.systemLogger.info(this.LOG_TAG, `${standardRelays.length} own + ${outboundRelays.length} author's + ${aggregatorRelays.length} aggregator = ${combined.length} total`);
      return combined;
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Discovery failed, using standard relays: ${error}`);
      return standardRelays;
    }
  }

  private parseRelayListEvent(event: NostrEvent): UserRelayList | null {
    try {
      const writeRelays: string[] = [];
      const readRelays: string[] = [];

      for (const tag of event.tags) {
        if (tag[0] === 'r' && tag[1]) {
          const relayUrl = tag[1];
          const marker = tag[2];

          if (!marker) {
            writeRelays.push(relayUrl);
            readRelays.push(relayUrl);
          } else if (marker === 'write') {
            writeRelays.push(relayUrl);
          } else if (marker === 'read') {
            readRelays.push(relayUrl);
          }
        }
      }

      return {
        pubkey: event.pubkey,
        writeRelays: [...new Set(writeRelays)],
        readRelays: [...new Set(readRelays)],
        lastUpdated: Date.now()
      };
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Parse relay list event error: ${error}`);
      return null;
    }
  }

  private getCachedRelayList(pubkey: string): UserRelayList | null {
    return this.relayListCache.get(pubkey) ?? null;
  }

  private cacheRelayList(relayList: UserRelayList): void {
    this.relayListCache.set(relayList.pubkey, relayList);
    // Write-through to IndexedDB. Best-effort: persistence failure does not
    // affect the in-memory cache, which still serves the rest of the session.
    void this.persistToIDB(relayList);
  }

  /**
   * Open (or create on first use) the shared IndexedDB store. Single global DB
   * since relay lists are public NIP-65 metadata, not per-account state.
   */
  private openIDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'pubkey' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Restore non-expired relay lists from IndexedDB into the in-memory LRU.
   * Runs once at construction; subsequent reads come straight from the LRU.
   */
  private async restoreFromIDB(): Promise<void> {
    try {
      if (typeof indexedDB === 'undefined') return;

      const db = await this.openIDB();
      const entries: UserRelayList[] = await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result as UserRelayList[]);
        request.onerror = () => reject(request.error);
      });

      const now = Date.now();
      let restored = 0;
      let expired = 0;
      for (const entry of entries) {
        if (entry && entry.pubkey && now - entry.lastUpdated < this.CACHE_TTL) {
          this.relayListCache.set(entry.pubkey, entry);
          restored++;
        } else {
          expired++;
        }
      }
      db.close();

      // Best-effort sweep of expired rows so the IDB store doesn't grow unbounded.
      if (expired > 0) {
        void this.pruneExpiredIDB();
      }

      if (restored > 0) {
        this.systemLogger.info(this.LOG_TAG, `Restored ${restored} relay lists from IndexedDB (${expired} expired)`);
      }
    } catch (error) {
      this.systemLogger.warn(this.LOG_TAG, `IndexedDB restore failed: ${error}`);
    }
  }

  /**
   * Write a single relay list to IndexedDB. Errors are logged but never thrown:
   * persistence is a session-survival optimization, not a correctness requirement.
   */
  private async persistToIDB(relayList: UserRelayList): Promise<void> {
    try {
      if (typeof indexedDB === 'undefined') return;

      const db = await this.openIDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(IDB_STORE).put(relayList);
      });
      db.close();
    } catch (error) {
      this.systemLogger.warn(this.LOG_TAG, `IndexedDB persist failed: ${error}`);
    }
  }

  private async pruneExpiredIDB(): Promise<void> {
    try {
      if (typeof indexedDB === 'undefined') return;

      const db = await this.openIDB();
      const cutoff = Date.now() - this.CACHE_TTL;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const value = cursor.value as UserRelayList;
            if (!value || !value.lastUpdated || value.lastUpdated < cutoff) {
              cursor.delete();
            }
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (error) {
      this.systemLogger.warn(this.LOG_TAG, `IndexedDB prune failed: ${error}`);
    }
  }

  private isValidRelay(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'wss:' || parsed.protocol === 'ws:';
    } catch {
      return false;
    }
  }

  private getHostname(url: string): string | null {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private isKnownRelay(hostname: string, relayUrls: string[]): boolean {
    return relayUrls.some(relay => this.getHostname(relay) === hostname);
  }

  private isQualityRelay(url: string): boolean {
    const hostname = this.getHostname(url);
    if (!hostname) return false;

    const configuredRelays = this.relayConfig.getAllRelays().map(r => r.url);
    if (this.isKnownRelay(hostname, configuredRelays)) return true;

    const aggregatorRelays = this.relayConfig.getAggregatorRelays();
    if (this.isKnownRelay(hostname, aggregatorRelays)) return true;

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.includes('.local') ||
      hostname.startsWith('test.') ||
      hostname.startsWith('dev.') ||
      hostname.startsWith('staging.')
    ) {
      return false;
    }

    return hostname.includes('.') && hostname.length > 4;
  }

  public getStats(): RelayDiscoveryStats {
    return { ...this.stats };
  }

  public clearCache(): void {
    this.relayListCache.clear();
    // Also flush persisted entries so a reload doesn't resurrect the cleared cache.
    void this.clearIDB();
    this.systemLogger.info(this.LOG_TAG, 'Cache cleared');
  }

  private async clearIDB(): Promise<void> {
    try {
      if (typeof indexedDB === 'undefined') return;
      const db = await this.openIDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(IDB_STORE).clear();
      });
      db.close();
    } catch (error) {
      this.systemLogger.warn(this.LOG_TAG, `IndexedDB clear failed: ${error}`);
    }
  }

  public getCacheStatus(): { size: number; ttl: number } {
    return { size: this.relayListCache.size, ttl: this.CACHE_TTL };
  }

  public onui(): void {}
  public onopen(): void {}
  public onmessage(): void {}
  public onclose(): void {}

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error(this.LOG_TAG, `Relay error (${relay}): ${error.message}`);
  }

  public override destroy(): void {
    this.relayListCache.clear();
    super.destroy();
    this.systemLogger.info(this.LOG_TAG, 'Destroyed');
  }
}
