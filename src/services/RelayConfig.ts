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
  private loadLocalRelaySettings(): { enabled: boolean; url: string; mode: string } {
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
   * Get aggregator relays that index events from many other relays
   */
  public getAggregatorRelays(): string[] {
    return [
      'wss://relay.damus.io',
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://purplepag.es',
      'wss://relay.mostr.pub'
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
   * Save relay list to per-account cache
   */
  private saveToCache(): void {
    try {
      const relayArray = Array.from(this.relays.values());
      this.perAccountStorage.set(StorageKeys.RELAY_LIST, relayArray);
    } catch (error) {
      // Failed to save to cache
    }
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
   * Load relay list for user: cache-first, then fetch from relays if needed
   * Emits 'relays:loaded' when done (for UI updates)
   */
  private async loadRelayListForUser(pubkey: string): Promise<void> {
    // 1. Try to load from per-account cache first (synchronous)
    if (this.loadFromCache()) {
      this.systemLogger.info(
        'RelayConfig',
        `✓ Loaded ${this.relays.size} relays from cache`
      );
      this.eventBus.emit('relays:loaded');
      return;
    }

    // 2. No cache - fetch from relays (async)
    await this.fetchAndLoadRelayList(pubkey);
    this.eventBus.emit('relays:loaded');
  }

  /**
   * Fetch and load user's relay list from NIP-65 (kind:10002)
   */
  private async fetchAndLoadRelayList(pubkey: string): Promise<void> {
    const relayListOrchestrator = RelayListOrchestrator.getInstance();

    const profileService = UserProfileService.getInstance();
    const username = profileService.getUsername(pubkey) || pubkey.slice(0, 8) + '...';

    const bootstrapRelays = this.getBootstrapRelays();

    this.systemLogger.info(
      'RelayConfig',
      `Fetching ${username}'s relay list from relays`
    );

    const relayInfos = await relayListOrchestrator.fetchRelayList(
      pubkey,
      bootstrapRelays
    );

    if (!relayInfos || relayInfos.length === 0) {
      this.systemLogger.info(
        'RelayConfig',
        'No relay list found on relays, using defaults'
      );
      return;
    }

    this.relays.clear();
    relayInfos.forEach(relay => {
      this.relays.set(relay.url, relay);
    });

    this.saveToCache();

    this.systemLogger.info(
      'RelayConfig',
      `✓ Loaded ${relayInfos.length} relays from NIP-65`
    );
  }

  /**
   * Get bootstrap relays for fetching user's NIP-65 relay list at login
   */
  private getBootstrapRelays(): string[] {
    return this.getAggregatorRelays();
  }
}
