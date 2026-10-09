/**
 * RelayRateLimitGuard - Relay-friendly backoff + REQ accounting
 *
 * Context: nos.lol / nostr.mom (and most strfry relays) enforce per-IP REQ
 * caps (nos.lol: 200 REQ/10s) and auto-ban addresses that keep exceeding
 * them. NoorNote previously had ZERO rate-limit awareness: a relay saying
 * "rate-limited" via NOTICE or CLOSED changed nothing about our sending
 * pattern, and NDK 3.0.3 reconnects any >60s-old socket with 0ms delay.
 *
 * This guard closes that gap at the app level (no NDK patch):
 *
 *  1. Rate-limit signals — relay NOTICEs and subscription CLOSED reasons
 *     matching throttle phrasing put the relay into exponential backoff.
 *     While backed off, the relay is excluded from every read-relay set
 *     (RelayConfig filters through here), so scheduled polls (timeline
 *     60s poll, AutoSync, notification refreshes) skip it.
 *
 *  2. Reconnect-storm guard — connect events per relay in a sliding
 *     window. Too many reconnects in a short time (the "75 reconnects per
 *     hour" ban signature) disconnects the relay and backs it off; the
 *     transport-provided reconnector brings it back after the backoff
 *     expires. A manual disconnect() is respected by NDK (it does not
 *     auto-reconnect those), so this actually stops the loop.
 *
 *  3. REQ accounting + NIP-11 — every REQ-creating transport call counts
 *     per relay in a rolling 60s window. Relay NIP-11 `limitation.max_reqs`
 *     (requests/minute) is fetched lazily (fire-and-forget, Accept:
 *     application/nostr+json, same host we already talk to) and tightens
 *     the warning thresholds. Crossing a threshold is logged — advisory,
 *  not blocking: silently delaying fetches would corrupt UX timing.
 */

import { diagLog } from '../DiagnosticLogger';
import { SystemLogger } from '../SystemLogger';

/** Throttle phrasing seen in relay NOTICEs and CLOSED reasons. */
export const RATE_LIMIT_RE =
  /rate.?limit|too many|maximum|exceeded|slow ?down|temporarily ban|blocked|restricted/i;

export const STORM_WINDOW_MS = 10 * 60_000;
/** Connects within the window that count as a reconnect storm. */
export const STORM_THRESHOLD = 8;
/** Exponential backoff steps (minutes). */
export const BACKOFF_STEPS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000];

/** Advisory thresholds (REQs/min) when no NIP-11 data is known. */
export const REQ_WARN_PER_MIN_DEFAULT = 600; // ≈ 100 REQ/10s
export const REQ_CRITICAL_PER_MIN_DEFAULT = 1100; // ≈ nos.lol's 200 REQ/10s cap

/** Rolling window for REQ accounting. */
export const REQ_WINDOW_MS = 60_000;

export type RateLimitSource = 'notice' | 'closed' | 'storm';

export class RelayRateLimitGuard {
  private static instance: RelayRateLimitGuard;

  /** url → backoff expiry (ms epoch). */
  private backoffUntil: Map<string, number> = new Map();
  /** url → current backoff step index (for exponential escalation). */
  private backoffLevel: Map<string, number> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  /** url → connect timestamps (storm window). */
  private connectTimes: Map<string, number[]> = new Map();
  /** url → REQ timestamps (rolling 60s accounting). */
  private reqTimes: Map<string, number[]> = new Map();
  /** url → NIP-11 limitation.max_reqs (per minute), when known. */
  private nip11MaxReqs: Map<string, number> = new Map();
  private nip11Attempted: Set<string> = new Set();
  /** url → last warned threshold level ('warn' | 'critical'), resets each window. */
  private warnedLevel: Map<string, string> = new Map();

  /** Transport-provided: reconnect a relay after storm backoff expiry. */
  private reconnector: ((url: string) => void) | null = null;
  /** Transport-provided: disconnect a relay when a storm backoff starts. */
  private disconnector: ((url: string) => void) | null = null;

  private systemLogger: SystemLogger;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): RelayRateLimitGuard {
    if (!RelayRateLimitGuard.instance) {
      RelayRateLimitGuard.instance = new RelayRateLimitGuard();
    }
    return RelayRateLimitGuard.instance;
  }

  /** Wire transport-side reconnect/disconnect (called once from NostrTransport). */
  public setTransportHooks(
    reconnector: (url: string) => void,
    disconnector: (url: string) => void
  ): void {
    this.reconnector = reconnector;
    this.disconnector = disconnector;
  }

  public isBackedOff(url: string): boolean {
    const until = this.backoffUntil.get(url);
    return until !== undefined && Date.now() < until;
  }

  /** Remaining backoff in ms (0 = not backed off). */
  public backoffRemainingMs(url: string): number {
    const until = this.backoffUntil.get(url);
    return until === undefined ? 0 : Math.max(0, until - Date.now());
  }

  /** Filter a relay list down to relays not currently in backoff. */
  public filter(urls: string[]): string[] {
    if (this.backoffUntil.size === 0) return urls;
    return urls.filter(url => !this.isBackedOff(url));
  }

  /**
   * Record a rate-limit signal (throttle NOTICE/CLOSED wording or a
   * reconnect storm). Starts or escalates the relay's exponential backoff.
   * `storm` additionally disconnects the relay for the backoff duration —
   * NDK respects manual disconnects (no auto-reconnect), which is what
   * actually breaks the instant-reconnect loop.
   */
  public observeRateLimitSignal(
    url: string,
    source: RateLimitSource,
    detail?: string
  ): void {
    if (!url) return;

    // Learn the relay's real budget for the diagnostics trail.
    this.fetchNip11IfNeeded(url);

    const now = Date.now();
    if (this.isBackedOff(url)) {
      // Still backed off — escalate one step (capped) and re-arm expiry.
      const level = Math.min(
        (this.backoffLevel.get(url) ?? 0) + 1,
        BACKOFF_STEPS_MS.length - 1
      );
      this.startBackoff(url, level, source, now, detail);
      return;
    }

    this.startBackoff(url, 0, source, now, detail);
  }

  private startBackoff(
    url: string,
    level: number,
    source: RateLimitSource,
    now: number,
    detail?: string
  ): void {
    const duration =
      BACKOFF_STEPS_MS[level] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!;
    this.backoffLevel.set(url, level);
    this.backoffUntil.set(url, now + duration);

    const host = url.replace(/^wss?:\/\//, '');
    const minutes = Math.round(duration / 60_000);
    if (source === 'storm') {
      this.systemLogger.warn(
        'RelayGuard',
        `Relay ${host} keeps reconnecting — pausing it for ${minutes} min`
      );
    } else {
      this.systemLogger.warn(
        'RelayGuard',
        `Relay ${host} says it's rate-limiting us — backing off ${minutes} min`
      );
    }
    diagLog('relays', 'Rate-limit backoff started', {
      relay: url,
      source,
      level,
      durationMs: duration,
      detail: detail?.slice(0, 200),
    });

    // Storm: cut the socket NOW — NDK will not auto-reconnect a manual
    // disconnect, so this is what ends the reconnect loop.
    if (source === 'storm') {
      try {
        this.disconnector?.(url);
      } catch {
        /* ignore */
      }
    }

    // Reconnect when the backoff expires (only meaningful after a storm
    // disconnect; harmless for soft backoffs where the socket stayed open).
    const existing = this.reconnectTimers.get(url);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(url);
      this.backoffUntil.delete(url);
      this.backoffLevel.delete(url);
      this.connectTimes.set(url, []); // fresh storm window
      try {
        this.reconnector?.(url);
      } catch {
        /* ignore */
      }
      diagLog('relays', 'Rate-limit backoff expired — relay re-enabled', {
        relay: url,
      });
    }, duration);
    this.reconnectTimers.set(url, timer);
  }

  /**
   * Record a successful connect. Tracks the storm window; crossing the
   * threshold triggers a storm backoff (disconnect + pause).
   */
  public observeConnect(url: string): void {
    if (!url) return;
    const now = Date.now();
    const times = (this.connectTimes.get(url) ?? []).filter(
      t => now - t < STORM_WINDOW_MS
    );
    times.push(now);
    this.connectTimes.set(url, times);

    if (times.length >= STORM_THRESHOLD && !this.isBackedOff(url)) {
      this.observeRateLimitSignal(
        url,
        'storm',
        `${times.length} connects in ${STORM_WINDOW_MS / 60_000} min`
      );
    }
  }

  // ── REQ accounting (advisory) ────────────────────────────────────────────

  /**
   * Count one outgoing REQ against each of the given relays (rolling 60s
   * window). Warns once per window when thresholds are crossed — advisory
   * observability, not throttling. NIP-11 discovery fires on demand (first
   * warn crossing / first rate-limit signal), NOT on every relay contact —
   * no extra outbound calls beyond what the feature literally needs.
   */
  public countRequest(urls: string[]): void {
    const now = Date.now();
    for (const url of urls) {
      if (!url) continue;

      const times = (this.reqTimes.get(url) ?? []).filter(
        t => now - t < REQ_WINDOW_MS
      );
      times.push(now);
      this.reqTimes.set(url, times);

      const maxReqs = this.nip11MaxReqs.get(url);
      const warnAt = maxReqs ? maxReqs * 0.5 : REQ_WARN_PER_MIN_DEFAULT;
      const criticalAt = maxReqs ? maxReqs * 0.9 : REQ_CRITICAL_PER_MIN_DEFAULT;
      const level =
        times.length >= criticalAt
          ? 'critical'
          : times.length >= warnAt
            ? 'warn'
            : null;
      if (!level || this.warnedLevel.get(url) === level) continue;
      this.warnedLevel.set(url, level);

      // First warn crossing: learn the relay's real NIP-11 budget so the
      // critical threshold can adapt on subsequent windows.
      if (level === 'warn') this.fetchNip11IfNeeded(url);

      const host = url.replace(/^wss?:\/\//, '');
      if (level === 'critical') {
        this.systemLogger.warn(
          'RelayGuard',
          `Heavy request load on ${host} — throttling ourselves to stay welcome`
        );
      }
      diagLog('relays', 'REQ budget warning', {
        relay: url,
        level,
        reqsLastMinute: times.length,
        nip11MaxReqsPerMin: maxReqs ?? null,
      });
    }
  }

  /** REQs sent to a relay in the last 60s (diagnostics/tests). */
  public reqsLastMinute(url: string): number {
    const now = Date.now();
    return (this.reqTimes.get(url) ?? []).filter(t => now - t < REQ_WINDOW_MS)
      .length;
  }

  /** NIP-11 relay information, lazily fetched once per session per relay. */
  private fetchNip11IfNeeded(url: string): void {
    if (this.nip11Attempted.has(url)) return;
    this.nip11Attempted.add(url);

    const httpUrl = url.startsWith('wss://')
      ? url.replace('wss://', 'https://')
      : url.replace('ws://', 'http://');

    try {
      void fetch(httpUrl, {
        headers: { Accept: 'application/nostr+json' },
        signal: AbortSignal.timeout(5000),
      })
        .then(res => (res.ok ? res.json() : null))
        .then((info: unknown) => {
          // Shape per NIP-11: { limitation: { max_reqs: number } } — treat as
          // untrusted JSON (any relay can serve anything here).
          const limitation = (info as { limitation?: { max_reqs?: unknown } })
            ?.limitation;
          const maxReqs = limitation?.max_reqs;
          if (typeof maxReqs === 'number' && maxReqs > 0) {
            this.nip11MaxReqs.set(url, maxReqs);
            diagLog('relays', 'NIP-11 limitation learned', {
              relay: url,
              maxReqsPerMin: maxReqs,
            });
          }
        })
        .catch(() => {
          // No NIP-11 / CORS-restricted — defaults apply. Non-fatal.
        });
    } catch {
      // Malformed URL etc. — defaults apply.
    }
  }

  /** Clear timers (app teardown). */
  public destroy(): void {
    this.reconnectTimers.forEach(timer => clearTimeout(timer));
    this.reconnectTimers.clear();
    this.backoffUntil.clear();
    this.backoffLevel.clear();
    this.connectTimes.clear();
    this.reqTimes.clear();
    this.nip11Attempted.clear();
    this.nip11MaxReqs.clear();
    this.warnedLevel.clear();
  }
}
