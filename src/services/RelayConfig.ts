/**
 * Relay Configuration Service
 * Manages user's relay settings and preferences
 * Fetches user's relay list (NIP-65) on login
 *
 * Storage: Per-account via PerAccountLocalStorage
 * - On login: Load from cache first, fetch from relays if no cache
 * - On logout: Clear memory, keep cache for next login
 * - Emits 'relays:loaded' after loading (for UI updates)
 */

import { EventBus } from './EventBus';
import { SystemLogger } from '../components/system/SystemLogger';
import { UserProfileService } from './UserProfileService';
import { RelayListOrchestrator } from './orchestration/RelayListOrchestrator';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { isDataSaverEnabled } from './DataSaverService';

export type RelayType = 'read' | 'write' | 'inbox';

export interface RelayInfo {
  url: string;
  name?: string;
  types: RelayType[];
  isPaid: boolean;
  requiresAuth: boolean;
  isActive: boolean;
  lastConnected?: Date;
  errorCount?: number;
}

export class RelayConfig {
  private static instance: RelayConfig;
  private relays: Map<string, RelayInfo> = new Map();
  private eventBus: EventBus;
  private systemLogger: SystemLogger;
  private perAccountStorage: PerAccountLocalStorage;

  private constructor() {
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.perAccountStorage = PerAccountLocalStorage.getInstance();

    this.initializeDefaultRelays();
    this.setupLoginListener();
  }

  public static getInstance(): RelayConfig {
    if (!RelayConfig.instance) {
      RelayConfig.instance = new RelayConfig();
    }
    return RelayConfig.instance;
  }

  /**
   * Initialize with aggregator relays for new users / logged out state
   */
  private initializeDefaultRelays(): void {
    if (this.relays.size === 0) {
      const aggregatorUrls = this.getAggregatorRelays();
      aggregatorUrls.forEach(url => {
        const relay: RelayInfo = {
          url,
          types: ['read', 'write'],
          isPaid: false,
          requiresAuth: false,
          isActive: true
        };
        this.relays.set(url, relay);
      });
    }
  }

  /**
   * Get relays filtered by type
   */
  public getRelaysByType(type: RelayType): RelayInfo[] {
    return Array.from(this.relays.values())
      .filter(relay => relay.isActive && relay.types.includes(type))
      .sort((a, b) => {
        if (a.isPaid === b.isPaid) return 0;
        return a.isPaid ? 1 : -1;
      });
  }

  /**
   * Get read relays for timeline loading
   */
  public getReadRelays(): string[] {
    const readRelays = this.getRelaysByType('read')
      .map(relay => relay.url);

    const localRelaySettings = this.loadLocalRelaySettings();
    if (localRelaySettings.enabled) {
      if (!readRelays.includes(localRelaySettings.url)) {
        readRelays.push(localRelaySettings.url);
      }
    }

    const aggregatorRelays = this.getAggregatorRelays();
    for (const aggregator of aggregatorRelays) {
      if (!readRelays.includes(aggregator)) {
        readRelays.push(aggregator);
      }
    }

    return readRelays;
  }

  /**
   * Load local relay settings from localStorage
   */
  public loadLocalRelaySettings(): { enabled: boolean; url: string; mode: string } {
    try {
      const stored = localStorage.getItem('noornote_local_relay');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      // Failed to load local relay settings
    }

    return {
      enabled: false,
      mode: 'test',
      url: 'ws://localhost:7777'
    };
  }

  /**
   * Get write relays for publishing
   */
  public getWriteRelays(): string[] {
    return this.getRelaysByType('write')
      .map(relay => relay.url);
  }

  /**
   * Get inbox relays for DMs
   */
  public getInboxRelays(): string[] {
    return this.getRelaysByType('inbox')
      .map(relay => relay.url);
  }

  /**
   * Add or update a relay
   */
  public addRelay(relayInfo: Omit<RelayInfo, 'errorCount' | 'lastConnected'>): void {
    const existing = this.relays.get(relayInfo.url);
    const relay: RelayInfo = {
      ...relayInfo,
      errorCount: existing?.errorCount || 0
    };
    if (existing?.lastConnected) {
      relay.lastConnected = existing.lastConnected;
    }

    this.relays.set(relayInfo.url, relay);
    this.saveToCache();
  }

  /**
   * Remove a relay
   */
  public removeRelay(url: string): void {
    this.relays.delete(url);
    this.saveToCache();
  }

  /**
   * Update relay connection status
   */
  public updateRelayStatus(url: string, connected: boolean, error?: boolean): void {
    const relay = this.relays.get(url);
    if (relay) {
      if (connected) {
        relay.lastConnected = new Date();
        relay.errorCount = 0;
      } else if (error) {
        relay.errorCount = (relay.errorCount || 0) + 1;
      }
      this.saveToCache();
    }
  }

  /**
   * Get all relays for management UI
   */
  public getAllRelays(): RelayInfo[] {
    return Array.from(this.relays.values());
  }

  /**
   * Background fallback layer for content lookups and broad-reach
   * broadcasts. Includes both mainstream content-relays (damus, snort,
   * nos.lol, primal, offchain-via-NoteService's read-set union) AND
   * the canonical profile-indexer (purplepag.es).
   *
   * Used by:
   *   - `publishEverywhere` (kind:0 / kind:10002 / kind:10050) — so
   *     identity + relay-list metadata is broadly findable.
   *   - `NoteService.fetchFromRelays` (bookmark resolution, quoted
   *     notes, deep-link by event-id) — events whose author we don't
   *     pre-know need a broad fetch surface.
   *   - `BroadcastDeleteService` — kind:5 deletions need maximum reach.
   *   - `ZapStatsService`, `FollowerCountService` — broad stats fetches.
   *   - `StarterFeedOrchestrator`, `PublicTimelineComponent` —
   *     onboarding paths where the user has no relay-setup yet.
   *   - `NotificationsOrchestrator`, `ReactionsOrchestrator` — broad
   *     coverage for reactor-pubkeys we don't know in advance.
   *
   * Yes, these relays overlap with what the wizard suggests as the
   * user's default content-relay set (damus / nos.lol / primal /
   * offchain). The overlap is intentional structural redundancy:
   * multiple code paths can independently reach the same relay,
   * NDK pools a single WebSocket per URL, so there is no double-
   * connection cost. A previous attempt (66c1e727) to trim this set
   * down to purplepag-only broke bookmark resolution, zap stats,
   * broadcast-delete reach and onboarding feed coverage — reverted.
   */
  public getAggregatorRelays(): string[] {
    if (isDataSaverEnabled()) {
      return [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net'
      ];
    }
    return [
      'wss://relay.damus.io',
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://purplepag.es',
      'wss://relay.mostr.pub',
      'wss://relay.zapstore.dev'
    ];
  }

  /**
   * Discovery + dedicated metadata indexers. Used for `publishEverywhere`
   * broadcasts of identity events (kind:0 / kind:10002 / kind:10050) so
   * other clients can find the user's relay-list and profile regardless
   * of which relays they happen to query.
   */
  public getMetadataRelays(): string[] {
    if (isDataSaverEnabled()) {
      return [
        ...this.getAggregatorRelays(),
        'wss://purplepag.es'
      ];
    }
    return [
      ...this.getAggregatorRelays(),
      'wss://index.hzrd149.com/',
      'wss://indexer.coracle.social/',
      'wss://user.kindpag.es/'
    ];
  }

  /**
   * Get user-configured read relays (excludes aggregator relays)
   */
  public getUserReadRelays(): string[] {
    const aggregators = new Set(this.getAggregatorRelays());
    const readRelays = this.getRelaysByType('read')
      .map(relay => relay.url)
      .filter(url => !aggregators.has(url));

    const localRelaySettings = this.loadLocalRelaySettings();
    if (localRelaySettings.enabled && !readRelays.includes(localRelaySettings.url)) {
      readRelays.push(localRelaySettings.url);
    }

    return readRelays;
  }

  /**
   * Get fallback following list when user has no follows
   */
  public getFallbackFollowing(): string[] {
    return [
      'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
      'npub12rv5lskctqxxs2c8rf2zlzc7xx3qpvzs3w4etgemauy9thegr43sf485vg',
      'npub1az9xj85cmxv8e9j9y80lvqp97crsqdu2fpu3srwthd99qfu9qsgstam8y8',
      'npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk'
    ];
  }

  /**
   * Load relay list from per-account cache
   * Returns true if cache was loaded, false if empty
   */
  private loadFromCache(): boolean {
    try {
      const cached = this.perAccountStorage.get<RelayInfo[]>(StorageKeys.RELAY_LIST, []);
      if (cached.length > 0) {
        this.relays.clear();
        cached.forEach(relay => {
          this.relays.set(relay.url, relay);
        });
        return true;
      }
    } catch (error) {
      // Failed to load from cache
    }
    return false;
  }

  /**
   * Save relay list to per-account cache.
   * Advances both timestamps (for local UI changes via addRelay/removeRelay).
   */
  private saveToCache(): void {
    try {
      const now = Math.floor(Date.now() / 1000);
      const relayArray = Array.from(this.relays.values());
      this.perAccountStorage.set(StorageKeys.RELAY_LIST, relayArray);
      this.perAccountStorage.set(StorageKeys.RELAY_LIST_TIMESTAMP, now);
      this.perAccountStorage.set(StorageKeys.INBOX_RELAY_LIST_TIMESTAMP, now);
    } catch (error) {
      // Failed to save to cache
    }
  }

  /**
   * Get cached relay list timestamp (created_at of last Kind 10002)
   */
  private getCacheTimestamp(): number {
    return this.perAccountStorage.get<number>(StorageKeys.RELAY_LIST_TIMESTAMP, 0);
  }

  /**
   * Get cached inbox relay list timestamp (created_at of last Kind 10050)
   */
  private getInboxCacheTimestamp(): number {
    return this.perAccountStorage.get<number>(StorageKeys.INBOX_RELAY_LIST_TIMESTAMP, 0);
  }

  /**
   * Reset to default configuration (memory only)
   */
  public resetToDefaults(): void {
    this.relays.clear();
    this.initializeDefaultRelays();
  }

  /**
   * Clear all relays from memory (no re-init of defaults)
   */
  public clearRelays(): void {
    this.relays.clear();
  }

  /**
   * Setup listener for user login/logout
   */
  private setupLoginListener(): void {
    this.eventBus.on('user:login', async (data: { npub: string; pubkey: string }) => {
      await this.loadRelayListForUser(data.pubkey);
    });

    this.eventBus.on('user:logout', () => {
      this.systemLogger.info('RelayConfig', 'User logged out, resetting to defaults');
      this.resetToDefaults();
      this.eventBus.emit('relays:updated');
      this.eventBus.emit('relays:loaded');
    });
  }

  /**
   * Load relay list for user: cache first for instant UI, then background-sync
   * from relays to pick up changes made on other instances.
   * Emits 'relays:loaded' when cache is ready, 'relays:updated' if relay data is newer.
   */
  private async loadRelayListForUser(pubkey: string): Promise<void> {
    const hadCache = this.loadFromCache();

    if (hadCache) {
      this.systemLogger.info('RelayConfig', `Loaded ${this.relays.size} relays from cache`);
      this.eventBus.emit('relays:loaded');

      // Background-sync: check relays for newer list (don't block UI)
      this.syncFromRelays(pubkey);
      return;
    }

    // No cache — must fetch before UI can proceed
    await this.syncFromRelays(pubkey);
    this.eventBus.emit('relays:loaded');
  }

  /**
   * Merge a fetched relay kind into the relay map, replacing old entries of that type
   * category while preserving other types. Returns summary parts for logging.
   */
  private mergeRelayKind(
    result: { relays: RelayInfo[]; timestamp: number },
    typesToReplace: RelayType[],
    label: string
  ): string[] {
    const replaceSet = new Set(typesToReplace);
    const parts: string[] = [];

    // Compute old URLs that have any of the types being replaced
    const oldUrls = new Set(
      [...this.relays.values()]
        .filter(r => r.types.some(t => replaceSet.has(t)))
        .map(r => r.url)
    );
    const newUrls = new Set(result.relays.map(r => r.url));

    const added = [...newUrls].filter(url => !oldUrls.has(url)).length;
    const removed = [...oldUrls].filter(url => !newUrls.has(url)).length;

    // Strip replaced types from all relays, remove those with no types left
    for (const [url, relay] of this.relays) {
      relay.types = relay.types.filter(t => !replaceSet.has(t));
      if (relay.types.length === 0) this.relays.delete(url);
    }

    // Merge new relays, preserving existing types from other kinds
    for (const relay of result.relays) {
      const existing = this.relays.get(relay.url);
      if (existing) {
        existing.types = [...new Set([...existing.types, ...relay.types])];
      } else {
        this.relays.set(relay.url, { ...relay });
      }
    }

    if (added > 0) parts.push(`${added} new ${label}${added > 1 ? 's' : ''}`);
    if (removed > 0) parts.push(`${removed} ${label}${removed > 1 ? 's' : ''} removed`);
    return parts;
  }

  /**
   * Fetch relay lists from relays (Kind 10002 + Kind 10050) and update if newer.
   * Called on first login (blocking) and as background-sync (non-blocking).
   */
  private async syncFromRelays(pubkey: string): Promise<void> {
    const orchestrator = RelayListOrchestrator.getInstance();
    const profileService = UserProfileService.getInstance();
    const username = profileService.getUsername(pubkey) || pubkey.slice(0, 8) + '...';

    this.systemLogger.info('RelayConfig', `Syncing ${username}'s relay list`);

    try {
      const bootstrapRelays = this.getBootstrapRelays();

      // Fetch Kind 10002 (read/write) and Kind 10050 (inbox) in parallel
      const [relayResult, inboxResult] = await Promise.all([
        orchestrator.fetchRelayList(pubkey, bootstrapRelays),
        orchestrator.fetchDMRelayList(pubkey, bootstrapRelays)
      ]);

      const parts: string[] = [];
      let newRelayTimestamp: number | undefined;
      let newInboxTimestamp: number | undefined;

      // --- Kind 10002: read/write relays ---
      if (relayResult && relayResult.relays.length > 0 && relayResult.timestamp > this.getCacheTimestamp()) {
        parts.push(...this.mergeRelayKind(relayResult, ['read', 'write'], 'relay'));
        newRelayTimestamp = relayResult.timestamp;
      }

      // --- Kind 10050: inbox relays ---
      if (inboxResult && inboxResult.relays.length > 0 && inboxResult.timestamp > this.getInboxCacheTimestamp()) {
        parts.push(...this.mergeRelayKind(inboxResult, ['inbox'], 'inbox relay'));
        newInboxTimestamp = inboxResult.timestamp;
      }

      const changed = newRelayTimestamp !== undefined || newInboxTimestamp !== undefined;

      if (changed) {
        try {
          const relayArray = Array.from(this.relays.values());
          this.perAccountStorage.set(StorageKeys.RELAY_LIST, relayArray);
          if (newRelayTimestamp) this.perAccountStorage.set(StorageKeys.RELAY_LIST_TIMESTAMP, newRelayTimestamp);
          if (newInboxTimestamp) this.perAccountStorage.set(StorageKeys.INBOX_RELAY_LIST_TIMESTAMP, newInboxTimestamp);
        } catch {
          // Failed to save to cache
        }

        if (parts.length === 0) parts.push('relay settings updated');
        this.systemLogger.success('RelayConfig', `Relay sync: ${parts.join(', ')}`);
        this.eventBus.emit('relays:updated');
      } else {
        const noData = (!relayResult || relayResult.relays.length === 0) &&
                       (!inboxResult || inboxResult.relays.length === 0);
        if (noData) {
          this.systemLogger.info('RelayConfig', 'No relay list found on relays, using defaults');
        } else {
          this.systemLogger.info('RelayConfig', 'Relay list is up to date');
        }
      }
    } catch (error) {
      console.debug('[RelayConfig] Background sync failed:', error);
    }
  }

  /**
   * Get bootstrap relays for fetching user's NIP-65 relay list at login
   */
  private getBootstrapRelays(): string[] {
    return this.getAggregatorRelays();
  }
}
