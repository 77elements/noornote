/**
 * NostrTransport - NDK Wrapper
 * Central transport layer for all Nostr relay communication
 *
 * Purpose: Abstracts NDK to provide unified relay access for Orchestrators
 * Used by: OrchestrationsRouter exclusively (no direct Component access)
 */

import NDK, { NDKEvent, NDKRelaySet, NDKSubscriptionCacheUsage } from '@nostr-dev-kit/ndk';
import NDKCacheDexie from '@nostr-dev-kit/ndk-cache-dexie';
import type { NDKCacheAdapter, NDKFilter, NDKRelay } from '@nostr-dev-kit/ndk';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { NDKCacheAdapterDexieOptions } from '@nostr-dev-kit/ndk-cache-dexie';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../../components/system/SystemLogger';
import { EventBus } from '../EventBus';
import { PlatformService } from '../PlatformService';

export interface SubscriptionCallbacks {
  onEvent: (event: NostrEvent, relay: string) => void;
  onEose?: () => void;
}

interface SubCloser {
  close: () => void;
}

/**
 * Get NDK cache configuration from localStorage
 * Returns default values if not configured
 * Desktop (Tauri): Large cache sizes for better performance
 * Web/Phone: Smaller cache sizes to reduce memory usage
 */
function getNDKCacheConfig(): NDKCacheAdapterDexieOptions {
  const STORAGE_KEY = 'ndk_cache_config';
  const platform = PlatformService.getInstance();
  const isDesktop = platform.isTauri && !platform.isAndroid;

  // Desktop: Large caches for performance
  // Web/Phone: Smaller caches for memory efficiency
  const DEFAULT_CONFIG = isDesktop ? {
    profileCacheSize: 100000,
    zapperCacheSize: 200,
    nip05CacheSize: 1000,
    eventCacheSize: 50000,
    eventTagsCacheSize: 100000,
    saveSig: false
  } : {
    profileCacheSize: 5000,
    zapperCacheSize: 100,
    nip05CacheSize: 500,
    eventCacheSize: 5000,
    eventTagsCacheSize: 10000,
    saveSig: false
  };

  // Only read custom config on Desktop (Web/Phone don't have settings UI)
  if (!isDesktop) {
    return { dbName: 'noornote', ...DEFAULT_CONFIG };
  }

  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return { dbName: 'noornote', ...DEFAULT_CONFIG };
  }

  try {
    const config = JSON.parse(stored);
    return { dbName: 'noornote', ...DEFAULT_CONFIG, ...config };
  } catch {
    return { dbName: 'noornote', ...DEFAULT_CONFIG };
  }
}

export class NostrTransport {
  private static instance: NostrTransport;
  private ndk: NDK;
  private ndkConnected: boolean = false;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private eventBus: EventBus;
  private subscriptions: Map<string, { closer: SubCloser; relays: string[] }> = new Map();

  private constructor() {
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = EventBus.getInstance();

    // Initialize NDK with Dexie cache (using config from localStorage)
    const cacheConfig = getNDKCacheConfig();
    this.ndk = new NDK({
      explicitRelayUrls: this.relayConfig.getReadRelays(),
      cacheAdapter: new NDKCacheDexie(cacheConfig) as unknown as NDKCacheAdapter,
      enableOutboxModel: false, // Disable for now, can enable later for performance
      autoConnectUserRelays: false // We manage relays explicitly via RelayConfig
    });

    this.systemLogger.info('NostrTransport', 'Transport ready');
  }

  // Shared promise prevents multiple parallel connect attempts
  private connectPromise: Promise<void> | null = null;

  /**
   * Ensure NDK is connected to relays (lazy connection)
   * Uses shared promise so parallel callers wait on the same connection attempt
   */
  private async ensureConnected(): Promise<void> {
    if (this.ndkConnected) {
      return;
    }

    // Reuse existing connection attempt if in progress
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // Start new connection attempt
    this.connectPromise = this.doConnect();
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.systemLogger.info('NostrTransport', 'Connecting to relays...');

    await this.ndk.connect(3000);

    const connectedRelays = Array.from(this.ndk.pool.relays.values())
      .filter(relay => relay.status === 1);

    this.ndkConnected = true;

    // Setup listeners for relay disconnect events
    this.setupRelayEventListeners();

    if (connectedRelays.length > 0) {
      this.systemLogger.success(
        'NostrTransport',
        `Connected to ${connectedRelays.length} of ${this.ndk.pool.relays.size} relays`
      );
    } else {
      this.systemLogger.info('NostrTransport', 'Relays connecting in background...');
    }
  }

  /**
   * Setup listeners for NDK relay events (disconnect, connect)
   * Forwards events to EventBus for ConnectivityService
   */
  private setupRelayEventListeners(): void {
    const setupRelayListeners = (relay: NDKRelay): void => {
      relay.on('disconnect', () => {
        this.eventBus.emit('relay:error', { url: relay.url });
      });
      relay.on('connect', () => {
        this.eventBus.emit('relay:connected', { url: relay.url });
      });
    };

    // Setup listeners for existing relays
    this.ndk.pool.relays.forEach(setupRelayListeners);

    // Listen for new relays added to pool
    this.ndk.pool.on('relay:connect', (relay: NDKRelay) => {
      this.eventBus.emit('relay:connected', { url: relay.url });
      setupRelayListeners(relay);
    });

    this.ndk.pool.on('relay:disconnect', (relay: NDKRelay) => {
      this.eventBus.emit('relay:error', { url: relay.url });
    });
  }

  public static getInstance(): NostrTransport {
    if (!NostrTransport.instance) {
      NostrTransport.instance = new NostrTransport();
    }
    return NostrTransport.instance;
  }

  /**
   * Connect to a specific relay and wait until connected
   * Use this for external relays (like NWC) before publishing
   */
  public async connectToRelay(url: string, timeoutMs: number = 5000): Promise<boolean> {
    await this.ensureConnected();

    // Check if relay is already connected
    const existingRelay = this.ndk.pool.relays.get(url);
    if (existingRelay && existingRelay.status === 1) {
      return true;
    }

    // Add relay to pool and connect
    const relay = this.ndk.pool.getRelay(url, true); // true = create if not exists

    if (!relay) {
      this.systemLogger.warn('NostrTransport', `Relay unavailable: ${url}`);
      return false;
    }

    // If already connected, return immediately
    if (relay.status === 1) {
      return true;
    }

    // Wait for connection with timeout
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.systemLogger.warn('NostrTransport', `Relay timeout: ${url}`);
        resolve(false);
      }, timeoutMs);

      const onConnect = () => {
        clearTimeout(timeout);
        relay.off('connect', onConnect);
        resolve(true);
      };

      relay.on('connect', onConnect);

      // Trigger connection if not already connecting
      if (relay.status === 0) { // 0 = DISCONNECTED
        relay.connect();
      }
    });
  }

  /**
   * Subscribe to events from relays
   * Returns a subscription wrapper with unsub() method
   *
   * NDK handles:
   * - Automatic signature verification
   * - Relay connection management
   * - Event deduplication
   */
  public async subscribe(
    relays: string[],
    filters: NDKFilter[],
    callbacks: SubscriptionCallbacks
  ): Promise<SubCloser> {
    await this.ensureConnected();

    const startTime = Date.now();
    let hasReceivedEvent = false;

    // Subscribe using NDK
    const ndkSub = this.ndk.subscribe(filters, {
      relayUrls: relays,
      closeOnEose: false // Keep subscription open for streaming
    }, {
      onEvent: (ndkEvent, relay) => {
        // Track successful connection and latency on first event
        if (!hasReceivedEvent) {
          hasReceivedEvent = true;
          const latency = Date.now() - startTime;
          this.eventBus.emit('relay:connected', { url: relay?.url || '', latency });
        }

        // NDK already verified signature - just forward the event
        const rawEvent = ndkEvent.rawEvent();
        callbacks.onEvent(rawEvent, relay?.url || '');
      },
      onEose: () => {
        // EOSE indicates successful connection
        if (!hasReceivedEvent) {
          const latency = Date.now() - startTime;
          this.eventBus.emit('relay:connected', { url: relays[0] || '', latency });
        }
        callbacks.onEose?.();
      }
    });

    // Return wrapper that implements SubCloser interface
    return {
      close: () => ndkSub.stop()
    };
  }

  /**
   * Fetch events from relays (one-time query)
   * Returns deduplicated events with relay tracking information
   *
   * NDK handles:
   * - Automatic deduplication
   * - Signature verification
   * - Concurrency management
   * - Relay connection pooling
   *
   * Note: For NIP-50 search queries (filters with 'search' field),
   * NDK's fetchEvents doesn't support custom filter fields.
   * Use raw WebSocket subscription instead.
   */
  public async fetch(
    relays: string[],
    filters: NDKFilter[],
    timeout: number = 5000,
    skipCache: boolean = false
  ): Promise<NostrEvent[]> {
    try {
      await this.ensureConnected();

      // Check if this is a NIP-50 search query (has 'search' field)
      // @ts-ignore - search field not in NDKFilter types
      const hasSearchField = filters.some(f => f.search);

      if (hasSearchField) {
        return this.fetchWithSearch(relays, filters, timeout);
      }

      // Standard fetch using NDK (auto-dedupe, auto-verify)
      // Use ONLY_RELAY when skipCache is true (for relay-specific filtering)
      const fetchPromise = this.ndk.fetchEvents(filters, {
        relayUrls: relays,
        closeOnEose: true,
        cacheUsage: skipCache ? NDKSubscriptionCacheUsage.ONLY_RELAY : NDKSubscriptionCacheUsage.CACHE_FIRST
      });

      // Apply timeout to prevent indefinite hangs on disconnected relays
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Fetch timeout')), timeout)
      );

      const eventSet = await Promise.race([fetchPromise, timeoutPromise]);

      // Convert Set<NDKEvent> to Array<NostrEvent>
      const events = Array.from(eventSet).map(ndkEvent => {
        const rawEvent = ndkEvent.rawEvent();

        // Tag event with relay URLs for compatibility
        Object.defineProperty(rawEvent, '_relays', {
          value: Array.from(ndkEvent.onRelays || []),
          enumerable: false,
          writable: true
        });

        return rawEvent;
      });

      return events;
    } catch (error) {
      this.systemLogger.error('NostrTransport', 'Failed to fetch events from relays');
      return [];
    }
  }

  /**
   * Fetch events with NIP-50 search support (raw WebSocket)
   * NDK doesn't support custom filter fields like 'search'
   */
  private async fetchWithSearch(
    relays: string[],
    filters: NDKFilter[],
    timeout: number = 5000
  ): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const events = new Map<string, NostrEvent>();
      const connections: WebSocket[] = [];
      let closedCount = 0;

      const cleanup = () => {
        connections.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        });
        resolve(Array.from(events.values()));
      };

      const timeoutId = setTimeout(cleanup, timeout);

      relays.forEach(relayUrl => {
        const ws = new WebSocket(relayUrl);
        connections.push(ws);

        ws.onopen = () => {
          const subId = Math.random().toString(36).substring(7);
          ws.send(JSON.stringify(['REQ', subId, ...filters]));
        };

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            const [type, _subId, event] = data;

            if (type === 'EVENT' && event) {
              events.set(event.id, event);
            } else if (type === 'EOSE') {
              ws.close();
            }
          } catch (_error) {
            // Ignore parse errors
          }
        };

        ws.onclose = () => {
          closedCount++;
          if (closedCount === relays.length) {
            clearTimeout(timeoutId);
            cleanup();
          }
        };

        ws.onerror = () => ws.close();
      });
    });
  }

  /**
   * Publish an event to relays
   */
  public async publish(relays: string[], event: NostrEvent): Promise<Set<string>> {
    await this.ensureConnected();

    this.systemLogger.info('NostrTransport', `Sending to ${relays.length} relays`);

    const ndkEvent = new NDKEvent(this.ndk, event);

    try {
      // Publish to specified relays with timeout
      const relaySet = new NDKRelaySet(
        new Set(relays.map(url => this.ndk.pool.getRelay(url)).filter(Boolean)),
        this.ndk
      );
      const publishPromise = ndkEvent.publish(relaySet, 10000);

      const publishedRelays = await publishPromise;

      const successful = publishedRelays.size;
      const failed = relays.length - successful;

      // Track relay health
      publishedRelays.forEach(relay => {
        this.eventBus.emit('relay:connected', { url: relay.url });
      });

      if (successful > 0) {
        this.systemLogger.success('NostrTransport', `Delivered to ${successful} of ${relays.length} relays`);
      }

      if (failed > 0 && successful > 0) {
        this.systemLogger.warn('NostrTransport', `${failed} relay${failed > 1 ? 's' : ''} didn't respond`);
      }

      // Only throw if ALL relays failed
      if (successful === 0) {
        this.systemLogger.error('NostrTransport', 'Delivery failed — no relays responded');
        throw new Error(`Failed to publish to any relay`);
      }

      // Return relay URLs (convert NDKRelay objects to strings)
      return new Set(Array.from(publishedRelays).map(relay => relay.url));
    } catch (error) {
      this.systemLogger.error('NostrTransport', 'Publish failed');
      throw error;
    }
  }

  /**
   * Close connections to specific relays
   */
  public close(relays: string[]): void {
    this.systemLogger.info('NostrTransport', `Disconnecting ${relays.length} relays`);

    relays.forEach(url => {
      const relay = this.ndk.pool.getRelay(url);
      if (relay) {
        relay.disconnect();
      }
    });
  }

  /**
   * Get read relays from config
   */
  public getReadRelays(): string[] {
    return this.relayConfig.getReadRelays();
  }

  /**
   * Get write relays from config
   */
  public getWriteRelays(): string[] {
    return this.relayConfig.getWriteRelays();
  }

  /**
   * Get the underlying NDK instance (for advanced usage)
   */
  public getNDK(): NDK {
    return this.ndk;
  }

  /**
   * Subscribe to events with persistent connection for live updates
   * @param relays - Relay URLs to subscribe to
   * @param filters - Nostr filters
   * @param subId - Unique subscription ID for tracking
   * @param callback - Called for each new event (event, relay)
   */
  public async subscribeLive(
    relays: string[],
    filters: NDKFilter[],
    subId: string,
    callback: (event: NostrEvent, relay: string) => void
  ): Promise<void> {
    await this.ensureConnected();

    // Subscription already active — skip silently
    if (this.subscriptions.has(subId)) {
      console.debug(`[NostrTransport] Subscription ${subId} already active, skipping`);
      return;
    }

    this.systemLogger.info('NostrTransport', `Listening on ${relays.length} relays`);

    // Subscribe using NDK (persistent connection)
    const ndkSub = this.ndk.subscribe(filters, {
      relayUrls: relays,
      closeOnEose: false // Keep subscription open for live updates
    }, {
      onEvent: (ndkEvent, relay) => {
        // NDK already verified signature - just forward the event
        const rawEvent = ndkEvent.rawEvent();
        callback(rawEvent, relay?.url || '');
      }
    });

    this.subscriptions.set(subId, { closer: { close: () => ndkSub.stop() }, relays });

    console.debug(`[NostrTransport] Subscription ${subId} active`);
  }

  /**
   * Unsubscribe and close a live subscription
   * @param subId - Subscription ID to close
   */
  public unsubscribeLive(subId: string): void {
    const subscription = this.subscriptions.get(subId);
    if (!subscription) {
      console.debug(`[NostrTransport] Subscription ${subId} not found`);
      return;
    }

    subscription.closer.close();
    this.subscriptions.delete(subId);
    console.debug(`[NostrTransport] Subscription ${subId} closed`);
  }

  /**
   * Cleanup all live subscriptions
   */
  public unsubscribeAll(): void {
    const count = this.subscriptions.size;
    this.subscriptions.forEach((subscription) => subscription.closer.close());
    this.subscriptions.clear();
    this.systemLogger.info('NostrTransport', `All ${count} subscriptions closed`);
  }
}
