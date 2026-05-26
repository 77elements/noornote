/**
 * NostrTransport - NDK Wrapper
 * Central transport layer for all Nostr relay communication
 *
 * Purpose: Abstracts NDK to provide unified relay access for Orchestrators
 * Used by: OrchestrationsRouter exclusively (no direct Component access)
 */

import NDK, { NDKEvent, NDKRelaySet, NDKSubscriptionCacheUsage, normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import NDKCacheDexie from '@nostr-dev-kit/ndk-cache-dexie';
import type { NDKCacheAdapter, NDKFilter, NDKRelay } from '@nostr-dev-kit/ndk';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { NDKCacheAdapterDexieOptions } from '@nostr-dev-kit/ndk-cache-dexie';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../SystemLogger';
import { TypedEventBus } from '../../core/TypedEventBus';
import { PlatformService } from '../PlatformService';
import { SignatureVerificationService } from '../security/SignatureVerificationService';
import { diagLog } from '../DiagnosticLogger';

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
 * Desktop (Electron): Large cache sizes for better performance
 * Web/Phone: Smaller cache sizes to reduce memory usage
 */
/** One-time migration: delete old Dexie DB if schema is incompatible with NDK v3 */
const NDK_CACHE_VERSION_KEY = 'ndk_cache_version';
const NDK_CACHE_VERSION = 3;
if (typeof indexedDB !== 'undefined') {
  const currentVersion = parseInt(localStorage.getItem(NDK_CACHE_VERSION_KEY) || '0');
  if (currentVersion < NDK_CACHE_VERSION) {
    indexedDB.deleteDatabase('noornote');
    localStorage.setItem(NDK_CACHE_VERSION_KEY, String(NDK_CACHE_VERSION));
  }
}

function getNDKCacheConfig(): NDKCacheAdapterDexieOptions {
  const STORAGE_KEY = 'ndk_cache_config';
  const platform = PlatformService.getInstance();
  const isDesktop = platform.isDesktop;

  // Desktop: Large caches for performance
  // Web/Phone: Smaller caches for memory efficiency
  const DEFAULT_CONFIG = isDesktop ? {
    profileCacheSize: 10000,
    zapperCacheSize: 200,
    nip05CacheSize: 500,
    eventCacheSize: 10000,
    eventTagsCacheSize: 20000,
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
  private eventBus: TypedEventBus;
  private subscriptions: Map<string, { closer: SubCloser; relays: string[] }> = new Map();

  private constructor() {
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();

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
      .filter(relay => relay.status >= 5);

    this.ndkConnected = true;

    // Setup listeners for relay disconnect events
    this.setupRelayEventListeners();

    diagLog('relays', 'NDK connected', { connected: connectedRelays.length, total: this.ndk.pool.relays.size });

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
   * Forwards events to TypedEventBus for ConnectivityService
   */
  private setupRelayEventListeners(): void {
    const setupRelayListeners = (relay: NDKRelay): void => {
      relay.on('disconnect', () => {
        diagLog('relays', 'Relay disconnected', { url: relay.url });
        this.eventBus.emit('relay:error', { url: relay.url });
      });
      relay.on('connect', () => {
        diagLog('relays', 'Relay connected', { url: relay.url });
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
    if (relay.status >= 5) {
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
    skipCache: boolean = false,
    caller: string = ''
  ): Promise<NostrEvent[]> {
    try {
      await this.ensureConnected();

      // Check if this is a NIP-50 search query (has 'search' field)
      // @ts-ignore - search field not in NDKFilter types
      const hasSearchField = filters.some(f => f.search);

      if (hasSearchField) {
        return this.fetchWithSearch(relays, filters, timeout);
      }

      // Ensure all relay URLs are in the NDK pool (NDK won't connect to unknown relays via relayUrls)
      // Similar to nostr-tools SimplePool.ensureRelay() — connection happens in parallel with fetch
      for (const url of relays) {
        if (!this.ndk.pool.relays.get(url)) {
          this.ndk.pool.getRelay(url, true); // add to pool, starts connecting
        }
      }

      // Standard fetch using NDK (auto-dedupe, auto-verify)
      // Use ONLY_RELAY when skipCache is true (for relay-specific filtering)
      const fetchPromise = this.ndk.fetchEvents(filters, {
        relayUrls: relays,
        closeOnEose: true,
        groupable: false,
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

      diagLog('relays', 'Fetch OK', { caller, relayCount: relays.length, kinds: filters.map(f => f.kinds || f.ids?.map(() => 'id-lookup') || ['unknown']).flat(), eventCount: events.length });
      return events;
    } catch (error) {
      diagLog('relays', 'Fetch failed', { caller, relayCount: relays.length, kinds: filters.map(f => f.kinds || f.ids?.map(() => 'id-lookup') || ['unknown']).flat(), error: String(error) });
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
              const verification = SignatureVerificationService.getInstance().verifyEvent(event);
              if (verification.valid) {
                events.set(event.id, event);
              }
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
   * Publish an event to relays.
   *
   * @param requiredRelayCount — if set, the returned promise resolves as soon as
   *   this many relays have ACKed. NDK keeps writing to the remaining relays in
   *   the background (no abort). Useful for latency-sensitive paths like NIP-17
   *   DMs where a single relay-ACK already guarantees deliverability while we
   *   still want maximum redundancy.
   */
  public async publish(relays: string[], event: NostrEvent, requiredRelayCount?: number): Promise<Set<string>> {
    await this.ensureConnected();

    this.systemLogger.info('NostrTransport', `Sending to ${relays.length} relays`);

    const ndkEvent = new NDKEvent(this.ndk, event);

    try {
      // Publish to specified relays with timeout
      const relaySet = new NDKRelaySet(
        new Set(relays.map(url => this.ndk.pool.getRelay(url)).filter(Boolean)),
        this.ndk
      );
      const publishPromise = ndkEvent.publish(relaySet, 10000, requiredRelayCount);

      const publishedRelays = await publishPromise;

      const successful = publishedRelays.size;
      const failed = relays.length - successful;

      // Track relay health
      publishedRelays.forEach(relay => {
        this.eventBus.emit('relay:connected', { url: relay.url });
      });

      diagLog('relays', 'Publish result', { successful, failed, total: relays.length, kind: event.kind });

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
      // NDKPublishError carries per-relay errors in `.errors` (Map<NDKRelay, Error>).
      // Pull them into the diagnostic log so future "0 published" reports can be
      // root-caused (auth-required, rate-limit, malformed-tag, blocked-pubkey, …)
      // from exported logs without needing live-console access. The top-level
      // "0 published, 1 required" message alone hides the actual cause.
      const errAny = error as { errors?: Map<{ url: string }, Error> };
      const perRelayErrors: Record<string, string> = {};
      if (errAny?.errors instanceof Map) {
        for (const [r, e] of errAny.errors.entries()) {
          perRelayErrors[r.url] = e.message ?? String(e);
        }
      }
      diagLog('relays', 'Publish failed', {
        relayCount: relays.length,
        kind: event.kind,
        error: String(error),
        ...(Object.keys(perRelayErrors).length > 0 ? { perRelayErrors } : {}),
      });
      this.systemLogger.error('NostrTransport', 'Publish failed');
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Publish helpers — semantic wrappers around `publish()` that decide the
  // relay set based on what kind of event is going out. Caller code SHOULD
  // use these instead of `publish(relays, event)` directly so the relay-
  // target policy stays consistent across the app and the Private-Relay-
  // Sovereignty story holds:
  //
  //   - `publishContent`     — user content (kind:0, 1, 3, 5, 6, 7, 9802,
  //                             30023, 30078, …). Strictly your own NIP-65
  //                             write-relays. No aggregators, no indexers.
  //                             Other clients find your content via your
  //                             kind:10002 — that's the discovery contract.
  //   - `publishEverywhere`  — discovery metadata (kind:10002, 10050). Sent
  //                             to write + read + aggregator + indexer set
  //                             so it's broadly findable. Solves the
  //                             bootstrap problem when the user switches
  //                             write-relays.
  //   - `publishWithHints`   — reactions (kind:7) + reposts (kind:6, 16).
  //                             Adds the relay-hints from the reacted-to
  //                             event so the original author actually
  //                             receives the reaction (Amethyst's
  //                             `computeRelayListToBroadcast` pattern).
  //   - `publishToInbox`     — NIP-17 DM gift-wraps (kind:1059). Caller
  //                             pre-resolves the recipient's kind:10050
  //                             inbox (with NIP-65-read fallback) and
  //                             passes it in.
  //
  // The low-level `publish(relays, event)` stays available for special
  // cases (relay-AUTH, ad-hoc test publishes, single-relay broadcasts).

  /**
   * Publish a content event to the user's own NIP-65 write-relays only.
   * No aggregators, no indexers — content discoverability flows through
   * the user's kind:10002.
   */
  public async publishContent(event: NostrEvent, requiredRelayCount?: number): Promise<Set<string>> {
    return this.publish(this.getWriteRelays(), event, requiredRelayCount);
  }

  /**
   * Publish a discovery-metadata event (kind:10002, 10050) to every
   * reachable relay — write + read + aggregator + indexer. Solves the
   * NIP-65 bootstrap problem: when the user changes their write-relays,
   * the new kind:10002 has to be findable on the relays other clients
   * already query, otherwise the switch is invisible to the network.
   */
  public async publishEverywhere(event: NostrEvent, requiredRelayCount?: number): Promise<Set<string>> {
    const set = new Set<string>([
      ...this.relayConfig.getWriteRelays(),
      ...this.relayConfig.getReadRelays(),
      ...this.relayConfig.getMetadataRelays(),
    ]);
    return this.publish([...set], event, requiredRelayCount);
  }

  /**
   * Publish a reaction or repost: own NIP-65 write-relays PLUS the
   * relay-hints extracted from the reacted-to event's e-tag (or wherever
   * the caller surfaces them from). That way the original author's
   * inbox-set picks the event up even if it's on relays the reactor
   * doesn't usually write to.
   *
   * Sanitises hints to wss:// / ws:// URLs only so a malformed hint
   * can't poison the relay set.
   */
  public async publishWithHints(event: NostrEvent, hintRelays: string[], requiredRelayCount?: number): Promise<Set<string>> {
    // Split into two independent publishes so a dead hint-relay (the
    // common case — author has a stale NIP-65 listing relays that went
    // offline) cannot drag down the user's own primary publish.
    //
    // The previous union approach was: one publish call with
    // [user write-relays, hint-relays] joined. NDK fires that as a
    // single relay-set publish; if the hint-relays' connect attempts
    // hang the overall publish-promise can resolve with "0 published,
    // 1 required" even when the user's healthy relays would have
    // accepted the event — the publish-threshold accounting gets
    // confused by the in-flight connect-attempts on the dead URLs.
    //
    // Semantic separation:
    //   1. Primary publish to the user's own write-relays. MUST succeed
    //      — that's where the user's own reaction must persist. Throws
    //      on full failure, surfaces to the UI as "publish failed".
    //   2. Best-effort publish to the hint-relays in parallel. Fire-
    //      and-forget; failure here is silently swallowed because the
    //      author's NIP-65 outbox being dead is not the reactor's
    //      problem. Caches a debug log so we can still see what
    //      happened during diagnostics.
    const writeRelays = this.getWriteRelays();
    // Dedupe hints against the primary publish-set after NDK URL
    // normalisation (trailing-slash + auth + hash stripping). Required,
    // not just an optimisation: NDK's relay.publish uses a per-relay
    // `openEventPublishes` array and the OK handler at `relay.ts:1074`
    // pops only ONE pending promise per OK. Publishing the SAME event-
    // id to the SAME NDKRelay through two relaySet.publish calls leaves
    // one promise dangling, the second relaySet.publish waits its full
    // timeout and then throws "0 published, 1 required" — even though
    // the relay actually accepted the event. Filtering overlap here
    // avoids that NDK pathology. Earlier attempts used raw string
    // equality which missed pairs like `wss://nos.lol` vs `wss://nos.lol/`.
    const writeSet = new Set(writeRelays.map(r => normalizeRelayUrl(r)));
    const safeHints = hintRelays
      .filter(r => r.startsWith('wss://') || r.startsWith('ws://'))
      .filter(r => !writeSet.has(normalizeRelayUrl(r)));

    // Primary publish — propagates errors to the caller for UI feedback.
    const accepted = await this.publish(writeRelays, event, requiredRelayCount);

    // Hint-publish AFTER the primary has resolved. Sequential — avoids
    // any concurrent pool mutation that might confuse NDK's per-relay
    // publish accounting. Best-effort fire-and-forget.
    if (safeHints.length > 0) {
      void this.publish(safeHints, event, 1).catch(err => {
        diagLog('relays', 'Hint-publish failed (non-fatal)', {
          kind: event.kind,
          hintCount: safeHints.length,
          error: String(err),
        });
      });
    }

    return accepted;
  }

  /**
   * Publish a NIP-17 DM gift-wrap (kind:1059) to the recipient's inbox
   * relays. Caller is responsible for resolving the inbox set (typically
   * kind:10050 with kind:10002-read as fallback) — this helper is just a
   * semantic alias around `publish()` so the call site reads "publish to
   * recipient inbox" instead of "publish to a bag of strings".
   */
  public async publishToInbox(event: NostrEvent, inboxRelays: string[], requiredRelayCount?: number): Promise<Set<string>> {
    return this.publish(inboxRelays, event, requiredRelayCount);
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
  }

  /**
   * Unsubscribe and close a live subscription
   * @param subId - Subscription ID to close
   */
  public unsubscribeLive(subId: string): void {
    const subscription = this.subscriptions.get(subId);
    if (!subscription) return;

    subscription.closer.close();
    this.subscriptions.delete(subId);
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
