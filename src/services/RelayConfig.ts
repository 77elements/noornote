/**
 * Relay Configuration Service
 * Manages user's relay settings and preferences
 * Fetches user's relay list (NIP-65) on login
 */

import { EventBus } from './EventBus';
import { SystemLogger } from '../components/system/SystemLogger';
import { UserProfileService } from './UserProfileService';
import { RelayListOrchestrator } from './orchestration/RelayListOrchestrator';

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
  private storageKey = 'noornote_relay_config';
  private eventBus: EventBus;
  private systemLogger: SystemLogger;

  private constructor() {
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    this.loadFromStorage();
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
   * Initialize with aggregator relays for new users
   */
  private initializeDefaultRelays(): void {
    // Only add default relays if user hasn't configured any yet
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
      this.saveToStorage();
    }
  }

  /**
   * Get relays filtered by type
   */
  public getRelaysByType(type: RelayType): RelayInfo[] {
    return Array.from(this.relays.values())
      .filter(relay => relay.isActive && relay.types.includes(type))
      .sort((a, b) => {
        // Prioritize free relays for reliability, then paid relays
        if (a.isPaid === b.isPaid) return 0;
        return a.isPaid ? 1 : -1;
      });
  }

  /**
   * Get read relays for timeline loading
   * In TEST mode: Returns public relays + local relay
   */
  public getReadRelays(): string[] {
    const readRelays = this.getRelaysByType('read')
      .map(relay => relay.url);

    // Check if local relay is enabled - if so, also read from it
    const localRelaySettings = this.loadLocalRelaySettings();
    if (localRelaySettings.enabled) {
      // Add local relay for reading (to see posts written to it)
      if (!readRelays.includes(localRelaySettings.url)) {
        readRelays.push(localRelaySettings.url);
      }
    }

    // Add aggregator relays for better event discovery
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
      errorCount: existing?.errorCount || 0,
      lastConnected: existing?.lastConnected
    };

    this.relays.set(relayInfo.url, relay);
    this.saveToStorage();
  }

  /**
   * Remove a relay
   */
  public removeRelay(url: string): void {
    this.relays.delete(url);
    this.saveToStorage();
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
      this.saveToStorage();
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
   * Always included in read queries for better event discovery
   */
  public getAggregatorRelays(): string[] {
    return [
      'wss://relay.damus.io',
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://relay.nostr.band',
      'wss://purplepag.es'
    ];
  }

  /**
   * Get user-configured read relays (excludes aggregator relays)
   * Used for relay filter dropdown in Timeline
   */
  public getUserReadRelays(): string[] {
    const aggregators = new Set(this.getAggregatorRelays());
    const readRelays = this.getRelaysByType('read')
      .map(relay => relay.url)
      .filter(url => !aggregators.has(url));

    // Check if local relay is enabled
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
      'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', // jack
      'npub12rv5lskctqxxs2c8rf2zlzc7xx3qpvzs3w4etgemauy9thegr43sf485vg', // fiatjaf
      'npub1az9xj85cmxv8e9j9y80lvqp97crsqdu2fpu3srwthd99qfu9qsgstam8y8', // vitor
      'npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk'  // odell
    ];
  }

  /**
   * Load configuration from localStorage
   */
  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const data = JSON.parse(stored);
        this.relays = new Map(Object.entries(data.relays || {}));
      }
    } catch (error) {
      // Failed to load relay config from storage
    }
  }

  /**
   * Save configuration to localStorage
   */
  private saveToStorage(): void {
    try {
      const data = {
        relays: Object.fromEntries(this.relays),
        lastUpdated: new Date().toISOString()
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      // Failed to save relay config to storage
    }
  }

  /**
   * Reset to default configuration
   */
  public resetToDefaults(): void {
    this.relays.clear();
    this.initializeDefaultRelays();
  }

  /**
   * Setup listener for user login to fetch NIP-65 relay list
   */
  private setupLoginListener(): void {
    this.eventBus.on('user:login', async (data: { npub: string; pubkey: string }) => {
      await this.fetchAndLoadRelayList(data.pubkey);
    });

    this.eventBus.on('user:logout', () => {
      this.systemLogger.info('RelayConfig', 'User logged out, resetting relays to defaults');
      this.resetToDefaults();
      this.eventBus.emit('relays:updated');
    });
  }

  /**
   * Fetch and load user's relay list from NIP-65 (kind:10002)
   */
  private async fetchAndLoadRelayList(pubkey: string): Promise<void> {
    const relayListOrchestrator = RelayListOrchestrator.getInstance();

    // Get username for logging
    const profileService = UserProfileService.getInstance();
    const username = profileService.getUsername(pubkey);

    // Use bootstrap relays from config/relays.json
    const bootstrapRelays = this.getBootstrapRelays();

    this.systemLogger.info(
      'RelayConfig',
      `Fetching ${username}'s relay list`
    );

    const relayInfos = await relayListOrchestrator.fetchRelayList(
      pubkey,
      bootstrapRelays
    );

    if (!relayInfos || relayInfos.length === 0) {
      this.systemLogger.info(
        'RelayConfig',
        'No relay list found, using defaults'
      );
      return;
    }

    // Clear existing relays and load NIP-65 relay list
    this.relays.clear();
    relayInfos.forEach(relay => {
      this.relays.set(relay.url, relay);
    });

    this.saveToStorage();

    this.systemLogger.info(
      'RelayConfig',
      `✓ Loaded ${relayInfos.length} relays from NIP-65`
    );

    // Don't emit 'relays:updated' on initial load (only on manual changes in Settings)
    // This prevents unnecessary Timeline refresh during login
  }

  /**
   * Get bootstrap relays for fetching user's NIP-65 relay list at login
   */
  private getBootstrapRelays(): string[] {
    return this.getAggregatorRelays();
  }
}
