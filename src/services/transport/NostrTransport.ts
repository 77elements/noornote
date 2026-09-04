/**
 * NostrTransport - NDK Wrapper
 * Central transport layer for all Nostr relay communication
 *
 * Purpose: Abstracts NDK to provide unified relay access for Orchestrators
 * Used by: OrchestrationsRouter exclusively (no direct Component access)
 */

import NDK, {
  NDKEvent,
  NDKRelaySet,
  NDKSubscription,
  NDKSubscriptionCacheUsage,
  normalizeRelayUrl,
  NDKRelayStatus,
  type NDKCacheAdapter,
  type NDKFilter,
  type NDKRelay,
  type NostrEvent,
} from '@nostr-dev-kit/ndk';
// NDK ships a ready signature-verification worker. ?worker&inline base64-embeds
// it into the bundle so it also loads under file:// (Electron/Capacitor), where
// a separate worker chunk URL would break.
import SigVerificationWorker from '@nostr-dev-kit/ndk/workers/sig-verification?worker&inline';
import NDKCacheDexie, {
  type NDKCacheAdapterDexieOptions,
} from '@nostr-dev-kit/ndk-cache-dexie';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../SystemLogger';
import { RelayHealthMonitor } from '../RelayHealthMonitor';
import { TypedEventBus } from '../../core/TypedEventBus';
import { PlatformService } from '../PlatformService';
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
  const currentVersion = parseInt(
    localStorage.getItem(NDK_CACHE_VERSION_KEY) || '0'
  );
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
  const DEFAULT_CONFIG = isDesktop
    ? {
        profileCacheSize: 10000,
        zapperCacheSize: 200,
        nip05CacheSize: 500,
        eventCacheSize: 10000,
        eventTagsCacheSize: 20000,
        saveSig: false,
      }
    : {
        profileCacheSize: 5000,
        zapperCacheSize: 100,
        nip05CacheSize: 500,
        eventCacheSize: 5000,
        eventTagsCacheSize: 10000,
        saveSig: false,
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
    // CacheSettingsSection-persisted overrides (own storage format)
    const config = JSON.parse(stored) as Record<string, unknown>;
    return {
      dbName: 'noornote',
      ...DEFAULT_CONFIG,
      ...config,
    } as NDKCacheAdapterDexieOptions;
  } catch {
    return { dbName: 'noornote', ...DEFAULT_CONFIG };
  }
}

function relayHost(url: string): string | null {
  try {
    // URL.hostname drops the [] around IPv6 literals
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True for hostnames pointing at loopback, LAN, link-local or IPv6 ULA space.
 * A public page must never open a WebSocket to these on the strength of an
 * untrusted event (a relay URL from another user's kind:10002 / kind:10050),
 * because it would make the visitor's browser probe their own local network.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost'))
    return true;
  if (h.includes(':')) {
    // IPv6 literal: loopback, unique-local (fc00::/7), link-local (fe80::/10)
    return (
      h === '::1' ||
      h.startsWith('fc') ||
      h.startsWith('fd') ||
      h.startsWith('fe80')
    );
  }
  return (
    h.startsWith('127.') ||
    h === '0.0.0.0' ||
    h.startsWith('192.168.') ||
    h.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.startsWith('169.254.')
  );
}

/**
 * Two guards, applied to every relay set before it reaches NDK:
 *
 * 1. Mixed-content: on an HTTPS page `new WebSocket('ws://…')` throws a
 *    SecurityError SYNCHRONOUSLY. Inside NDK's fetchEvents Promise.all that abort
 *    aborts the whole fetch, so a single ws:// relay in an author's kind:10002
 *    outbox left the timeline empty on the web (never locally, where file://-served
 *    Electron has no mixed-content rule). Strip ws:// when on HTTPS.
 *
 * 2. Local-network probe: relay URLs sourced from other users' relay-list events
 *    (kind:10002 / DM inbox kind:10050) can point at private space, e.g.
 *    `wss://192.168.0.104`. Opening a socket there makes the visitor's browser hit
 *    a device on THEIR own LAN. Block private/loopback/link-local hosts — except
 *    the user's OWN configured relays (the local TEST relay must keep working).
 */
function secureRelays(relays: string[]): string[] {
  const onHttps =
    typeof location !== 'undefined' && location.protocol === 'https:';

  let allowed: Set<string>;
  try {
    const cfg = RelayConfig.getInstance();
    const own = [
      ...cfg.getAllRelays().map(r => r.url),
      cfg.loadLocalRelaySettings().url,
    ];
    allowed = new Set(own.map(relayHost).filter((h): h is string => !!h));
  } catch {
    allowed = new Set();
  }

  return relays.filter(url => {
    if (onHttps && url.toLowerCase().startsWith('ws://')) return false;
    const host = relayHost(url);
    if (host && isPrivateHost(host) && !allowed.has(host)) return false;
    return true;
  });
}

// Bound the NDK relay pool. Per-author outbound discovery (stats, reactions,
// reposts, profile feeds) connects to every author's NIP-65 relays and NDK keeps
// them open forever — browsing piles up 170+ sockets until the browser's WS
// ceiling is hit and the feed can no longer connect (empty ProfileView). We keep
// the core relays + any relay an active subscription needs, and prune the rest
// past this cap. See docs/todos/timeline-component-modularization.md.
const MAX_POOL_RELAYS = 32;

export class NostrTransport {
  private static instance: NostrTransport;
  private ndk: NDK;
  private ndkConnected: boolean = false;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private eventBus: TypedEventBus;
  private subscriptions: Map<string, { closer: SubCloser; relays: string[] }> =
    new Map();
  private poolPruneInterval: ReturnType<typeof setInterval> | null = null;
  /** Relays each event was seen on (received from / published to) this session.
   *  Bounded, insertion-ordered — oldest entry evicted past the cap to keep the
   *  WebView's memory footprint fixed (IndexedDB eviction sensitivity). */
  private seenOnRelays: Map<string, Set<string>> = new Map();
  private static readonly SEEN_ON_MAX_ENTRIES = 5000;

  private constructor() {
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();

    // Initialize NDK with Dexie cache (using config from localStorage)
    const cacheConfig = getNDKCacheConfig();
    this.ndk = new NDK({
      explicitRelayUrls: secureRelays(this.relayConfig.getReadRelays()),
      cacheAdapter: new NDKCacheDexie(
        cacheConfig
      ) as unknown as NDKCacheAdapter,
      enableOutboxModel: false, // Disable for now, can enable later for performance
      autoConnectUserRelays: false, // We manage relays explicitly via RelayConfig
    });

    // Offload schnorr signature verification to a Web Worker so it never blocks
    // the main thread (NDK verifies every incoming event). Setting the worker
    // flips NDK to async verification; invalid sigs surface via 'event:invalid-sig'
    // instead of a sync return. If the worker can't start, NDK falls back to
    // main-thread verification on its own.
    try {
      this.ndk.signatureVerificationWorker = new SigVerificationWorker();
      this.ndk.on('event:invalid-sig', (event: NDKEvent, relay?: NDKRelay) => {
        // NDK already drops the event and adjusts that relay's trust ratio; we
        // only record it for diagnostics.
        console.debug(
          '[NostrTransport] invalid signature',
          event.id,
          relay?.url
        );
        diagLog('relays', 'invalid_signature', {
          eventId: event.id,
          relay: relay?.url,
        });
      });
    } catch (err) {
      console.debug(
        '[NostrTransport] sig-verification worker unavailable, using main thread',
        err
      );
    }

    // NIP-42 relay AUTH, scoped to the user's OWN relays. Without a policy NDK
    // silently ignores AUTH challenges, which made every auth-gated relay
    // (paid relays, private relays) refuse reads AND writes with
    // "auth-required" while showing up as generic relay errors. We only ever
    // authenticate against relays from the user's own read/write list (checked
    // at challenge time, so per-author outbound discovery relays never receive
    // the user's npub). Signing goes exclusively through AuthService — the
    // main NDK instance never gets a signer.
    this.ndk.relayAuthDefaultPolicy = (relay: NDKRelay, challenge: string) =>
      this.handleRelayAuth(relay, challenge);

    this.systemLogger.info('NostrTransport', 'Transport ready');

    // Socket-recovery lifecycle (see recoverConnections): browsers keep
    // half-open WebSockets after system suspend / network switches, and NDK
    // only notices once its own writes fail. Wire the recovery triggers.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.recoverConnections('online');
      });
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) {
            this.hiddenAt = Date.now();
          } else {
            const hiddenMs = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
            this.hiddenAt = null;
            // Only recover after a meaningful background stay — quick tab
            // switches must not churn healthy sockets.
            if (hiddenMs > 30_000) {
              this.recoverConnections('visible');
            }
          }
        });
      }
    }
  }

  /** Throttle + bookkeeping for socket-recovery passes. */
  private lastRecoveryAt = 0;
  private hiddenAt: number | null = null;
  private static readonly RECOVERY_THROTTLE_MS = 15_000;

  /**
   * Half-open socket recovery: after system suspend (laptop lid, Android
   * background) or a network switch, sockets can report CONNECTED while the
   * peer is long gone — NDK's own reconnect only fires when IT notices the
   * drop, which may never happen for a silently dead socket. A recovery pass
   * force-reconnects every pool socket that believes it is open; NDK then
   * re-establishes its active subscriptions on each reconnect (same path as
   * any normal network blip).
   *
   * Triggered on `online` and on tab-visible-after->30s. Throttled to one
   * pass per 15s so bursty triggers coalesce.
   */
  public recoverConnections(reason: 'online' | 'visible'): void {
    const now = Date.now();
    if (now - this.lastRecoveryAt < NostrTransport.RECOVERY_THROTTLE_MS) {
      return;
    }
    this.lastRecoveryAt = now;

    let rebuilt = 0;
    for (const relay of this.ndk.pool.relays.values()) {
      if (relay.status !== NDKRelayStatus.CONNECTED) continue;
      try {
        relay.disconnect();
        void relay.connect();
        rebuilt++;
      } catch (err) {
        diagLog('relays', 'Socket recovery reconnect failed (non-fatal)', {
          relay: relay.url,
          error: String(err),
        });
      }
    }

    if (rebuilt > 0) {
      diagLog('relays', `Socket recovery pass (${reason})`, { rebuilt });
      this.systemLogger.info(
        'NostrTransport',
        `Rebuilt ${rebuilt} relay connection(s) after ${reason}`
      );
    }
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

    const connectedRelays = Array.from(this.ndk.pool.relays.values()).filter(
      relay => relay.status >= NDKRelayStatus.CONNECTED
    );

    this.ndkConnected = true;

    // Setup listeners for relay disconnect events
    this.setupRelayEventListeners();

    // Periodically prune the relay pool so per-author outbound discovery can't grow
    // it without bound and exhaust the browser's WebSocket ceiling (connection-bloat fix).
    if (!this.poolPruneInterval) {
      this.poolPruneInterval = setInterval(() => this.pruneRelayPool(), 12000);
    }

    diagLog('relays', 'NDK connected', {
      connected: connectedRelays.length,
      total: this.ndk.pool.relays.size,
    });

    if (connectedRelays.length > 0) {
      this.systemLogger.success(
        'NostrTransport',
        `Connected to ${connectedRelays.length} of ${this.ndk.pool.relays.size} relays`
      );
    } else {
      this.systemLogger.info(
        'NostrTransport',
        'Relays connecting in background...'
      );
    }
  }

  /**
   * Keep the relay pool bounded. Core relays (read + aggregators) and any relay an
   * active subscription depends on are always kept; the rest — transient per-author
   * outbound relays from one-off fetches — are disconnected + removed once the pool
   * exceeds MAX_POOL_RELAYS. Best-effort.
   */
  private pruneRelayPool(): void {
    try {
      const pool = this.ndk.pool;
      const relays = pool.relays;
      if (relays.size <= MAX_POOL_RELAYS) return;

      const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();
      const keep = new Set<string>();
      [
        ...this.relayConfig.getReadRelays(),
        ...this.relayConfig.getAggregatorRelays(),
      ].forEach(u => keep.add(norm(u)));
      // Never prune a relay an active subscription is using.
      this.subscriptions.forEach(sub =>
        sub.relays.forEach(u => keep.add(norm(u)))
      );

      const prunable = [...relays.keys()].filter(url => !keep.has(norm(url)));
      let toClose = relays.size - MAX_POOL_RELAYS;
      let closed = 0;
      for (const url of prunable) {
        if (toClose <= 0) break;
        relays.get(url)?.disconnect();
        pool.removeRelay(url);
        toClose--;
        closed++;
      }
      if (closed > 0) {
        diagLog('relays', 'Pruned outbound relays from pool', {
          closed,
          poolSize: relays.size,
        });
      }
    } catch {
      // best-effort
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
  public async connectToRelay(
    url: string,
    timeoutMs: number = 5000
  ): Promise<boolean> {
    await this.ensureConnected();

    // Check if relay is already connected
    const existingRelay = this.ndk.pool.relays.get(url);
    if (existingRelay && existingRelay.status === NDKRelayStatus.DISCONNECTED) {
      return true;
    }

    // Add relay to pool and connect
    const relay = this.ndk.pool.getRelay(url, true); // true = create if not exists

    if (!relay) {
      this.systemLogger.warn('NostrTransport', `Relay unavailable: ${url}`);
      return false;
    }

    // If already connected, return immediately
    if (relay.status >= NDKRelayStatus.CONNECTED) {
      return true;
    }

    // Wait for connection with timeout
    return new Promise<boolean>(resolve => {
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
      if (relay.status === NDKRelayStatus.DISCONNECTING) {
        // 0 = DISCONNECTED
        void relay.connect();
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

    relays = secureRelays(relays);

    const startTime = Date.now();
    let hasReceivedEvent = false;

    // Subscribe using NDK
    const ndkSub = this.ndk.subscribe(
      filters,
      {
        relayUrls: relays,
        closeOnEose: false, // Keep subscription open for streaming
      },
      {
        onEvent: (ndkEvent, relay) => {
          // Track successful connection and latency on first event
          if (!hasReceivedEvent) {
            hasReceivedEvent = true;
            const latency = Date.now() - startTime;
            this.eventBus.emit('relay:connected', {
              url: relay?.url || '',
              latency,
            });
          }

          // NDK already verified signature - just forward the event
          const rawEvent = ndkEvent.rawEvent();
          callbacks.onEvent(rawEvent, relay?.url || '');
        },
        onEose: () => {
          // EOSE indicates successful connection
          if (!hasReceivedEvent) {
            const latency = Date.now() - startTime;
            this.eventBus.emit('relay:connected', {
              url: relays[0] || '',
              latency,
            });
          }
          callbacks.onEose?.();
        },
      }
    );

    // Return wrapper that implements SubCloser interface
    return {
      close: () => ndkSub.stop(),
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

      relays = secureRelays(relays);

      // Check if this is a NIP-50 search query (has 'search' field)
      const hasSearchField = filters.some(
        f => (f as NDKFilter & { search?: string }).search !== undefined
      );

      if (hasSearchField) {
        return this.fetchWithSearch(relays, filters, timeout);
      }

      // Ensure all relay URLs are in the NDK pool (NDK won't connect to unknown relays via relayUrls)
      // Similar to nostr-tools SimplePool.ensureRelay() — connection happens in parallel with fetch
      for (const url of relays) {
        if (!this.ndk.pool.relays.get(url)) {
          // temporary=true: transient relays (author-outbound, search) auto-remove
          // after 30s idle instead of living in the pool forever and being
          // reconnect-stormed (the cause of poolSize pegging at the cap → empty PV).
          // Only marks NOT-already-pooled relays; NDK never removes explicitRelayUrls.
          this.ndk.pool.getRelay(url, true, true);
        }
      }

      // Standard fetch using NDK (auto-dedupe, auto-verify)
      // Use ONLY_RELAY when skipCache is true (for relay-specific filtering)
      const fetchPromise = this.ndk.fetchEvents(filters, {
        relayUrls: relays,
        closeOnEose: true,
        groupable: false,
        cacheUsage: skipCache
          ? NDKSubscriptionCacheUsage.ONLY_RELAY
          : NDKSubscriptionCacheUsage.CACHE_FIRST,
      });

      // Apply timeout to prevent indefinite hangs on disconnected relays
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Fetch timeout')), timeout)
      );

      const eventSet = await Promise.race([fetchPromise, timeoutPromise]);

      // Convert Set<NDKEvent> to Array<NostrEvent>
      const events = Array.from(eventSet).map(ndkEvent => {
        const rawEvent = ndkEvent.rawEvent();

        // Record which relays this event was received from (for "Seen on").
        this.recordSeenOn(
          rawEvent.id,
          Array.from(ndkEvent.onRelays || []).map(r => r.url)
        );

        return rawEvent;
      });

      diagLog('relays', 'Fetch OK', {
        caller,
        relayCount: relays.length,
        kinds: filters
          .map(f => f.kinds || f.ids?.map(() => 'id-lookup') || ['unknown'])
          .flat(),
        eventCount: events.length,
      });
      return events;
    } catch (error) {
      diagLog('relays', 'Fetch failed', {
        caller,
        relayCount: relays.length,
        kinds: filters
          .map(f => f.kinds || f.ids?.map(() => 'id-lookup') || ['unknown'])
          .flat(),
        error: String(error),
      });
      this.systemLogger.error(
        'NostrTransport',
        'Failed to fetch events from relays'
      );
      return [];
    }
  }

  /**
   * Fetch events with NIP-50 search support. Routes through directFetch (pooled
   * NDK subscriptions); NDK does serialize the `search` filter field.
   */
  private async fetchWithSearch(
    relays: string[],
    filters: NDKFilter[],
    timeout: number = 5000
  ): Promise<NostrEvent[]> {
    return this.fetchDirect(relays, filters, timeout, 'search');
  }

  /**
   * Clean, relay-only fetch over NDK's POOLED connections: one single-relay
   * subscription per relay, each pinned to its relay (relayUrls + exclusiveRelay)
   * with ONLY_RELAY + groupable:false. That gives EXACTLY what each relay returns
   * — no cache, no outbox expansion, no cross-subscription filter-merge bleed —
   * while REUSING the persistent per-relay socket (NDK multiplexes all REQs over
   * one socket per relay). The previous version opened a raw `new WebSocket` per
   * fetch, which accumulated until Chrome refused new sockets and every relay
   * errored in ~3ms → empty ProfileView (#2). Per-relay subs are required (not one
   * multi-relay sub) so NDK's per-id dedup can't distort per-relay counts, which
   * the frontier pagination depends on. NDK auto-verifies signatures.
   */
  private async directFetch(
    relays: string[],
    filters: NDKFilter[],
    timeout: number = 5000,
    caller: string = '',
    perRelayUntil?: Record<string, number>,
    waitForAll: boolean = false
  ): Promise<{
    events: NostrEvent[];
    perRelay: Record<
      string,
      { oldest: number | null; count: number; eosed: boolean }
    >;
  }> {
    relays = secureRelays(relays);
    // Passive health scoring (M5.2): fastest-first ordering so the fetch
    // quorum is reached by healthy relays instead of stalled stragglers;
    // penalized relays (≥3 failures, 0 successes in 15 min) go last.
    // perRelayUntil is URL-keyed — ordering cannot break pagination cursors.
    relays = RelayHealthMonitor.getInstance().sortByScore(relays);
    const dbgStart = Date.now();
    // Per-relay outcome: oldest created_at (this relay's next loadMore cursor),
    // count (to detect exhaustion), eosed, plus state/ms for diagnostics. Each
    // relay pages its own history independently — a single global cursor let
    // sparse relays drag pagination back years and skip the dense middle.
    const perRelay: Record<
      string,
      {
        oldest: number | null;
        count: number;
        eosed: boolean;
        state: string;
        ms: number;
      }
    > = {};
    relays.forEach(u => {
      perRelay[u] = {
        oldest: null,
        count: 0,
        eosed: false,
        state: 'pending',
        ms: 0,
      };
    });

    // Pre-add each relay to NDK's pool so the single-relay subscriptions below
    // REUSE the shared per-relay socket instead of opening a new one.
    for (const url of relays) {
      // temporary=true: transient relays (PV outbound, search) auto-remove after
      // 30s idle instead of accumulating in the pool and being reconnect-stormed.
      if (!this.ndk.pool.relays.get(url))
        this.ndk.pool.getRelay(url, true, true);
    }

    const label = (u: string) => u.replace('wss://', '').replace(/\/$/, '');
    return new Promise(resolve => {
      const events = new Map<string, NostrEvent>();
      const subs: NDKSubscription[] = [];
      let settledRelays = 0;
      let done = false;
      // let (not const): assigned once below AFTER finish() captures it in a
      // closure — a const initializer at the assignment site would escape
      // finish's scope.
      // eslint-disable-next-line prefer-const
      let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;

      // Quorum is a render trigger, not a stop: once a quorum of relays has
      // answered AND we have events, resolve after a short grace instead of
      // waiting on stragglers. The events-present guard keeps a genuinely empty
      // result waiting until the hard timeout, so we never flash empty early.
      const QUORUM = Math.max(1, Math.ceil(relays.length * 0.6));
      const GRACE_MS = 1000;

      const finish = () => {
        if (done) return;
        done = true;
        if (graceTimer) clearTimeout(graceTimer);
        if (hardTimeoutId) clearTimeout(hardTimeoutId);
        subs.forEach(s => {
          try {
            s.stop();
          } catch {
            /* ignore */
          }
        });
        diagLog('relays', 'Direct fetch OK', {
          caller,
          relayCount: relays.length,
          eventCount: events.size,
        });
        const breakdown = relays.map(u => {
          const r = perRelay[u]!;
          return `${label(u)}=${r.state}(${r.count}${r.ms ? `,${r.ms}ms` : ''})`;
        });
        // Persist the fetch outcome so a cold empty-PV is recoverable later
        // (diagLog — on web this lands in the IndexedDB ring buffer). poolSize
        // captures socket bloat; per-relay state shows "all relays errored" —
        // the #2 signature.
        diagLog('relays', 'direct-fetch', {
          caller,
          ms: Date.now() - dbgStart,
          total: events.size,
          quorum: `${QUORUM}/${relays.length}`,
          poolSize: this.ndk?.pool?.relays?.size ?? -1,
          relays: breakdown,
        });
        resolve({ events: Array.from(events.values()), perRelay });
      };

      if (relays.length === 0) {
        finish();
        return;
      }

      hardTimeoutId = setTimeout(() => {
        relays.forEach(u => {
          const r = perRelay[u]!;
          if (r.state === 'pending') {
            r.state = 'timeout';
            // Never answered within the budget — a request-level failure for
            // passive health scoring (M5.2).
            RelayHealthMonitor.getInstance().observeFailure(u);
          }
        });
        finish();
      }, timeout);

      const markSettled = (url: string, state: string) => {
        const r = perRelay[url]!;
        if (r.state !== 'pending') return; // already settled
        r.state = state;
        r.ms = Date.now() - dbgStart;
        // Passive health scoring (M5.2): EOSE with round-trip ms = success,
        // subscription error = failure.
        if (state === 'eosed') {
          RelayHealthMonitor.getInstance().observeSuccess(url, r.ms);
        } else {
          RelayHealthMonitor.getInstance().observeFailure(url);
        }
        settledRelays++;
        if (settledRelays >= relays.length) {
          finish(); // every relay answered — no reason to wait
          return;
        }
        // waitForAll callers (e.g. profile carousels fetching a few addressable
        // events) need completeness over speed: skip the quorum early-exit so a
        // slow-but-complete relay isn't cut off by fast-but-partial ones. Still
        // bounded by all-settled (above) and the hard timeout.
        if (
          !waitForAll &&
          settledRelays >= QUORUM &&
          events.size > 0 &&
          !graceTimer
        ) {
          graceTimer = setTimeout(finish, GRACE_MS);
        }
      };

      relays.forEach((relayUrl, i) => {
        const pr = perRelay[relayUrl]!;
        // Per-relay pagination: ask THIS relay for events older than its own
        // cursor; omit (initial load) → newest. -1 so the cursor note isn't refetched.
        const relayUntil = perRelayUntil ? perRelayUntil[relayUrl] : undefined;
        const relayFilters =
          relayUntil !== undefined
            ? filters.map(f => ({ ...f, until: relayUntil - 1 }))
            : filters;

        try {
          const sub = this.ndk.subscribe(relayFilters, {
            relayUrls: [relayUrl], // pin this relay → bypass outbox + reuse pooled socket
            cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
            groupable: false, // no filter-merge with other subscriptions
            exclusiveRelay: true, // drop events not from this relay (kills cross-sub bleed)
            closeOnEose: true,
            subId: `direct-${caller}-${i}`,
            onEvent: (
              ev: NDKEvent,
              _relay?: unknown,
              _sub?: unknown,
              fromCache?: boolean
            ) => {
              // Count ONLY fresh relay events. NDK's global dispatch also replays
              // cached events (from other subs' cache reads) whose seenOn includes
              // this relay; those would pollute the per-relay oldest/count that the
              // frontier pagination depends on (min(created_at) is wrecked by a few
              // stale outliers). ONLY_RELAY stops our own cache read, not the bus.
              if (fromCache) return;
              if (!ev.id) return;
              events.set(ev.id, ev as unknown as NostrEvent);
              pr.count++;
              if (
                ev.created_at !== undefined &&
                (pr.oldest === null || ev.created_at < pr.oldest)
              )
                pr.oldest = ev.created_at;
            },
            onEose: () => {
              pr.eosed = true;
              markSettled(relayUrl, 'eosed');
            },
          });
          subs.push(sub);
        } catch (_e) {
          markSettled(relayUrl, 'error');
        }
      });
    });
  }

  /**
   * One-shot relay-only fetch (raw WebSockets). Merged, deduped, signature-verified.
   * Used for NIP-50 search and any newest-N fetch over a known relay set.
   */
  public async fetchDirect(
    relays: string[],
    filters: NDKFilter[],
    timeout: number = 5000,
    caller: string = '',
    waitForAll: boolean = false
  ): Promise<NostrEvent[]> {
    return (
      await this.directFetch(
        relays,
        filters,
        timeout,
        caller,
        undefined,
        waitForAll
      )
    ).events;
  }

  /**
   * Per-relay paginated direct fetch. Each relay is queried for events older than
   * its own cursor in `perRelayUntil` (omit a relay → newest). Returns the merged
   * union plus, per relay, the oldest created_at seen (its next cursor), how many
   * it returned (to detect exhaustion) and whether it EOSE'd — so the caller can
   * page each relay independently and never skip the dense middle of a feed.
   */
  public async fetchDirectPaged(
    relays: string[],
    filters: NDKFilter[],
    perRelayUntil: Record<string, number>,
    timeout: number = 5000,
    caller: string = '',
    waitForAll: boolean = false
  ): Promise<{
    events: NostrEvent[];
    perRelay: Record<
      string,
      { oldest: number | null; count: number; eosed: boolean }
    >;
  }> {
    return this.directFetch(
      relays,
      filters,
      timeout,
      caller,
      perRelayUntil,
      waitForAll
    );
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
  public async publish(
    relays: string[],
    event: NostrEvent,
    requiredRelayCount?: number
  ): Promise<Set<string>> {
    await this.ensureConnected();

    relays = secureRelays(relays);

    this.systemLogger.info(
      'NostrTransport',
      `Sending to ${relays.length} relays`
    );

    const ndkEvent = new NDKEvent(this.ndk, event);

    try {
      // Publish to specified relays with timeout
      const relaySet = new NDKRelaySet(
        new Set(relays.map(url => this.ndk.pool.getRelay(url)).filter(Boolean)),
        this.ndk
      );
      const publishPromise = ndkEvent.publish(
        relaySet,
        10000,
        requiredRelayCount
      );

      const publishedRelays = await publishPromise;

      const successful = publishedRelays.size;
      const failed = relays.length - successful;

      // Passive health scoring (M5.2): ACKs are successes. Non-ACKed relays
      // only count as failures on a FULL broadcast (no requiredRelayCount) —
      // with a quorum threshold NDK keeps writing to the remaining relays in
      // the background, so "not yet ACKed" is not "failed" there.
      const ackedUrls = new Set(
        Array.from(publishedRelays).map(relay => relay.url)
      );
      const health = RelayHealthMonitor.getInstance();
      publishedRelays.forEach(relay => {
        this.eventBus.emit('relay:connected', { url: relay.url });
        health.observeSuccess(relay.url);
      });
      if (requiredRelayCount === undefined) {
        relays.forEach(url => {
          if (!ackedUrls.has(url)) {
            health.observeFailure(url);
          }
        });
      }

      diagLog('relays', 'Publish result', {
        successful,
        failed,
        total: relays.length,
        kind: event.kind,
      });

      if (successful > 0) {
        this.systemLogger.success(
          'NostrTransport',
          `Delivered to ${successful} of ${relays.length} relays`
        );
      }

      if (failed > 0 && successful > 0) {
        this.systemLogger.warn(
          'NostrTransport',
          `${failed} relay${failed > 1 ? 's' : ''} didn't respond`
        );
      }

      // Only throw if ALL relays failed
      if (successful === 0) {
        this.systemLogger.error(
          'NostrTransport',
          'Delivery failed — no relays responded'
        );
        // M6.1: hand the signed event to the offline publish queue (via the
        // event bus — the transport must not import the queue service, which
        // itself calls back into the transport for retries).
        this.eventBus.emit('publish:failed-all', { event, relays });
        throw new Error(`Failed to publish to any relay`);
      }

      // Return relay URLs (convert NDKRelay objects to strings)
      const publishedUrls = Array.from(publishedRelays).map(relay => relay.url);
      // Record where our own event went (so "Seen on" works for fresh posts).
      this.recordSeenOn(event.id, publishedUrls);
      return new Set(publishedUrls);
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

  /**
   * Record which relays an event was seen on / delivered to. Merges into the
   * existing set; evicts the oldest entry once the cap is reached.
   */
  private recordSeenOn(eventId: string | undefined, relayUrls: string[]): void {
    const urls = relayUrls.filter(Boolean);
    if (!eventId || urls.length === 0) return;

    let set = this.seenOnRelays.get(eventId);
    if (!set) {
      if (this.seenOnRelays.size >= NostrTransport.SEEN_ON_MAX_ENTRIES) {
        const oldest = this.seenOnRelays.keys().next().value;
        if (oldest !== undefined) this.seenOnRelays.delete(oldest);
      }
      set = new Set();
      this.seenOnRelays.set(eventId, set);
    }
    urls.forEach(url => set!.add(url));
  }

  /**
   * Relays a given event was seen on (received from) or published to this
   * session. Synchronous lookup by event id. Empty for events not seen this
   * session (e.g. loaded purely from the local cache).
   */
  public getEventRelays(eventId: string): string[] {
    return Array.from(this.seenOnRelays.get(eventId) ?? []);
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
  public async publishContent(
    event: NostrEvent,
    requiredRelayCount?: number
  ): Promise<Set<string>> {
    return this.publish(this.getWriteRelays(), event, requiredRelayCount);
  }

  /**
   * Publish a discovery-metadata event (kind:10002, 10050) to every
   * reachable relay — write + read + aggregator + indexer. Solves the
   * NIP-65 bootstrap problem: when the user changes their write-relays,
   * the new kind:10002 has to be findable on the relays other clients
   * already query, otherwise the switch is invisible to the network.
   */
  public async publishEverywhere(
    event: NostrEvent,
    requiredRelayCount?: number
  ): Promise<Set<string>> {
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
  public async publishWithHints(
    event: NostrEvent,
    hintRelays: string[],
    requiredRelayCount?: number
  ): Promise<Set<string>> {
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
      .filter(r => !writeSet.has(normalizeRelayUrl(r)))
      // Penalty box (M5.2): a relay with ≥3 failures and 0 successes in the
      // last 15 min is skipped for best-effort hint publishes — connecting to
      // it would stall the fire-and-forget round and it almost certainly
      // won't ACK. A single success anywhere clears the penalty.
      .filter(r => !RelayHealthMonitor.getInstance().isPenalized(r));

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
   * Publish a user-content event with author-outbox resolution: the user's
   * own NIP-65 write relays (primary, must succeed) plus the target
   * author(s)' outbound relays and any caller-supplied relay hints
   * (best-effort) — so the author's inbox-set reliably picks the event up
   * (reactions, reposts, …).
   *
   * Outbox resolution uses the narrow `discoverUserRelays + getOutboundRelays`
   * pair (NOT the broad `getCombinedRelays`): the latter unions in the user's
   * own read-set + aggregator relays, which then overlap with the primary
   * publish-set and trip NDK's per-relay duplicate-OK accounting ("0
   * published, 1 required" despite acceptance — see publishWithHints).
   * `getOutboundRelays` excludes the user's read-set internally, so the
   * resulting hint-set stays strictly author-specific.
   *
   * Discovery failure is non-fatal: falls back to caller hints + own write
   * relays. Dynamic-imports the orchestrator to avoid a transport ↔
   * orchestrator import cycle.
   */
  public async publishWithOutbox(
    event: NostrEvent,
    opts: {
      /** Pubkeys whose NIP-65 outbox should receive the event. */
      authorPubkeys?: string[];
      /** Caller-collected relay hints (e.g. e-tag hints from the note). */
      relayHints?: string[];
      requiredRelayCount?: number;
    } = {}
  ): Promise<Set<string>> {
    const { authorPubkeys = [], relayHints = [], requiredRelayCount } = opts;

    let authorOutbox: string[] = [];
    if (authorPubkeys.length > 0) {
      try {
        const { OutboundRelaysOrchestrator } = await import(
          '../orchestration/OutboundRelaysOrchestrator'
        );
        const orch = OutboundRelaysOrchestrator.getInstance();
        const relayLists = await orch.discoverUserRelays(authorPubkeys);
        authorOutbox = orch.getOutboundRelays(relayLists);
      } catch {
        /* fall back to caller hints + own write-relays only */
      }
    }

    const hints = [...new Set([...relayHints, ...authorOutbox])];
    return this.publishWithHints(event, hints, requiredRelayCount);
  }

  /**
   * Publish a NIP-17 DM gift-wrap (kind:1059) to the recipient's inbox
   * relays. Caller is responsible for resolving the inbox set (typically
   * kind:10050 with kind:10002-read as fallback) — this helper is just a
   * semantic alias around `publish()` so the call site reads "publish to
   * recipient inbox" instead of "publish to a bag of strings".
   */
  public async publishToInbox(
    event: NostrEvent,
    inboxRelays: string[],
    requiredRelayCount?: number
  ): Promise<Set<string>> {
    return this.publish(inboxRelays, event, requiredRelayCount);
  }

  /**
   * Close connections to specific relays
   */
  public close(relays: string[]): void {
    this.systemLogger.info(
      'NostrTransport',
      `Disconnecting ${relays.length} relays`
    );

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
   * NIP-42 relay AUTH handler (wired as ndk.relayAuthDefaultPolicy).
   *
   * Privacy scope: authenticating reveals the user's npub to the relay, so it
   * happens ONLY for relays from the user's own read/write list — never for
   * aggregators, other users' NIP-65 outbound relays, or publish hint-relays.
   * The membership check runs at challenge time (relays can join the pool
   * after construction). Returns the signed kind:22242 event for NDK to send,
   * or false to decline. Dynamic import keeps AuthService (which pulls the
   * signer stack) out of the transport's module graph.
   */
  private async handleRelayAuth(
    relay: NDKRelay,
    challenge: string
  ): Promise<NDKEvent | false> {
    try {
      const url = normalizeRelayUrl(relay.url);
      const own = new Set(
        [
          ...this.relayConfig.getReadRelays(),
          ...this.relayConfig.getWriteRelays(),
        ].map(r => normalizeRelayUrl(r))
      );

      if (!own.has(url)) {
        diagLog('relays', 'Declined relay AUTH (not an own relay)', {
          url: relay.url,
        });
        return false;
      }

      const { AuthService } = await import('../AuthService');
      const auth = AuthService.getInstance();
      const pubkey = auth.getCurrentUser()?.pubkey;
      if (!pubkey) return false;

      const signed = (await auth.signEvent({
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [
          ['relay', relay.url],
          ['challenge', challenge],
        ],
        pubkey,
      })) as NostrEvent;

      if (!signed) {
        diagLog('relays', 'Relay AUTH signing failed', { url: relay.url });
        return false;
      }

      diagLog('relays', 'Signed relay AUTH', { url: relay.url });
      return new NDKEvent(this.ndk, signed);
    } catch (error) {
      diagLog('relays', 'Relay AUTH handler failed', {
        url: relay.url,
        error: String(error),
      });
      return false;
    }
  }

  /**
   * Get write relays from config
   */
  public getWriteRelays(): string[] {
    return this.relayConfig.getWriteRelays();
  }

  /**
   * Get the underlying NDK instance.
   * @internal Only for signer/encryption managers (NIP-46/Bunker/NostrConnect,
   * DM encryption). Do NOT use for relay queries; use NostrTransport.fetch /
   * subscribe / publish so relay selection, pool caps and health policy apply.
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
    callback: (event: NostrEvent, relay: string) => void,
    onEose?: () => void
  ): Promise<void> {
    await this.ensureConnected();

    // Subscription already active — skip silently
    if (this.subscriptions.has(subId)) {
      return;
    }

    this.systemLogger.info(
      'NostrTransport',
      `Listening on ${relays.length} relays`
    );

    // Subscribe using NDK (persistent connection)
    const ndkCallbacks: {
      onEvent: (event: NDKEvent, relay?: NDKRelay) => void;
      onEose?: () => void;
    } = {
      onEvent: (ndkEvent, relay) => {
        // NDK already verified signature - just forward the event
        const rawEvent = ndkEvent.rawEvent();
        // Record which relay this live event arrived from (for "Seen on").
        this.recordSeenOn(rawEvent.id, [relay?.url || '']);
        callback(rawEvent, relay?.url || '');
      },
    };
    // onEose lets callers (e.g. DMService) distinguish the relay's replayed
    // initial backlog from the genuinely-live post-EOSE stream. NDK fires it
    // once per relay; callers guard on their side so only the first matters.
    if (onEose) ndkCallbacks.onEose = () => onEose();

    const ndkSub = this.ndk.subscribe(
      filters,
      {
        relayUrls: relays,
        closeOnEose: false, // Keep subscription open for live updates
      },
      ndkCallbacks
    );

    this.subscriptions.set(subId, {
      closer: { close: () => ndkSub.stop() },
      relays,
    });
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
    this.subscriptions.forEach(subscription => subscription.closer.close());
    this.subscriptions.clear();
    this.systemLogger.info(
      'NostrTransport',
      `All ${count} subscriptions closed`
    );
  }
}
