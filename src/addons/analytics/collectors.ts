/**
 * Analytics collectors — typing, shared relay sweeps and all five metric
 * groups (posts / follow / content / zaps / engagement).
 *
 * Relay discipline (docs/todos/analytics-addon.md): a run performs exactly
 * THREE sweeps, shared across collectors via the per-run SweepCache:
 *
 *   1. own-content  authors:[me]  kinds [1, 1111, 30023, 21, 22, 30402, 5]  → posts + content
 *   2. inbox        #p:[me]       kinds [1, 6, 1111, 9735, 7]               → zaps(received) + engagement + top-posts
 *   3. sent zaps    #P:[me]       kinds [9735]                              → zaps(sent, best effort)
 *
 * All sweeps run over read + aggregator relays, per-relay paginated via
 * NostrTransport.fetchDirectPaged (pooled sockets, NDK-verified), globally
 * deduped by event id and capped by a page limit (relay-friendliness).
 *
 * Incremental runs (P6): collectors receive the previous snapshot and a since
 * cursor; sweeps add `since` to the filter so only new events travel, and the
 * deltas merge additively into the persisted metrics.
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { OutboundRelaysOrchestrator } from '../../services/orchestration/OutboundRelaysOrchestrator';
import { ModuleLoader } from '../../core/ModuleLoader';
import { TypedEventBus } from '../../core/TypedEventBus';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import { FollowCheckService } from '../../services/FollowCheckService';
import { diagLog } from '../../services/DiagnosticLogger';
import {
  bucketEngagementTimeline,
  bucketSentZaps,
  classifyInbox,
  classifyOwnContent,
  classifySentZaps,
  computeZapsMetrics,
  extractOwnPosts,
  mergeCounts,
  mergeEngagementTimeline,
  mergeOwnContent,
  mergeTopPosts,
  pickEngagementUnit,
  tallyInboxByTarget,
  type EngagementBucket,
  type EngagementUnit,
  type LogicEvent,
  type TopPostEntry,
} from './analyticsLogic';

export type CollectorId =
  | 'posts'
  | 'follow'
  | 'content'
  | 'zaps'
  | 'engagement'
  | 'top-posts'
  | 'engagement-timeline';

export interface AuxData {
  /** Persisted own event ids (posts snapshot) — engagement validation basis. */
  ownEventIds?: string[];
  /** Persisted top-post entries (top-posts snapshot) — view list basis. */
  topPosts?: TopPostEntry[];
  /** Persisted engagement timeline buckets (Diagrams tab). */
  timeline?: EngagementBucket[];
  /** Bucket unit the timeline was built with (drift on unit change → Refresh). */
  timelineUnit?: EngagementUnit;
  /** Oldest own event seen (epoch seconds) — account-age basis for the unit. */
  oldestOwnEventAt?: number;
  /** Persisted SENT zap sats per bucket (Diagrams tab, sent-zaps sweep). */
  sentZapsTimeline?: EngagementBucket[];
}

export interface CollectorSnapshot {
  collectorId: CollectorId;
  metrics: Record<string, number>;
  /** created_at high-water mark — since cursor for incremental runs. */
  sinceCursor: number;
  /** Epoch ms of the creation. */
  fetchedAt: number;
  /** Collector-specific auxiliary data (own event ids etc.). */
  aux?: AuxData;
}

export interface RunContext {
  /** Hex pubkey of the logged-in user. */
  pubkey: string;
  /** true = full run (first run / Refresh) — since cursors are ignored. */
  fullRun: boolean;
  /** Previous snapshot of a collector (null on first run). */
  previous: (id: CollectorId) => CollectorSnapshot | null;
  /** Shared per-run sweep cache — dedupes relay traffic across collectors. */
  sweeps: SweepCache;
}

export interface AnalyticsCollector {
  readonly id: CollectorId;
  collect(ctx: RunContext): Promise<CollectorSnapshot>;
}

/** NDK's tuple-typed tags → LogicEvent boundary (one contained cast). */
function asLogic(events: NostrEvent[]): LogicEvent[] {
  return events as unknown as LogicEvent[];
}

// ─── Shared sweep infrastructure ─────────────────────────────────────────

const SWEEP_PAGE_LIMIT = 400;
const SWEEP_MAX_PAGES = 25;
const SWEEP_TIMEOUT_MS = 12_000;

/**
 * Per-run cache for the three relay sweeps. Two collectors requesting the
 * same sweep share ONE paginated fetch sequence — the whole run never
 * duplicates a relay request.
 */
export class SweepCache {
  private readonly transport = NostrTransport.getInstance();
  private readonly relayConfig = RelayConfig.getInstance();

  private ownContentEvents: NostrEvent[] | null = null;
  private ownContentPromise: Promise<NostrEvent[]> | null = null;
  private inboxEvents: NostrEvent[] | null = null;
  private inboxPromise: Promise<NostrEvent[]> | null = null;
  private sentZapsEvents: NostrEvent[] | null = null;
  private sentZapsPromise: Promise<NostrEvent[]> | null = null;

  private relays(): string[] {
    return [
      ...new Set([
        ...this.relayConfig.getReadRelays(),
        ...this.relayConfig.getAggregatorRelays(),
      ]),
    ];
  }

  /**
   * Own-content relay set: read + aggregator + the OWN NIP-65 write relays.
   * Articles/videos/listings often live ONLY on the author's write relays —
   * the exact reason ProfileCarouselOrchestrator broadens too. The outbound
   * discovery is IDB-cached, so this is one cheap extra fetch at most.
   */
  private async ownContentRelays(pubkey: string): Promise<string[]> {
    const base = this.relays();
    try {
      const outbound =
        await OutboundRelaysOrchestrator.getInstance().getCombinedRelays(
          [pubkey],
          true
        );
      return [...new Set([...base, ...outbound])];
    } catch {
      return base;
    }
  }

  /** Sweep 1: own content (posts/replies/comments/articles/videos/listings/deletions). */
  public ownContent(ctx: RunContext): Promise<NostrEvent[]> {
    if (this.ownContentEvents) return Promise.resolve(this.ownContentEvents);
    if (this.ownContentPromise) return this.ownContentPromise;

    const since = ctx.fullRun
      ? undefined
      : this.cursor(ctx, 'posts', 'content');
    this.ownContentPromise = this.ownContentRelays(ctx.pubkey)
      .then(relays =>
        this.sweep(
          relays,
          [
            {
              kinds: [1, 1111, 30023, 21, 22, 30402, 5],
              authors: [ctx.pubkey],
              limit: SWEEP_PAGE_LIMIT,
            },
          ],
          since,
          'own-content'
        )
      )
      .then(events => {
        this.ownContentEvents = events;
        return events;
      });
    return this.ownContentPromise;
  }

  /** Sweep 2: inbox (replies/reposts/quotes/zap receipts tagging #p:me). */
  public inbox(ctx: RunContext): Promise<NostrEvent[]> {
    if (this.inboxEvents) return Promise.resolve(this.inboxEvents);
    if (this.inboxPromise) return this.inboxPromise;

    const since = ctx.fullRun
      ? undefined
      : this.cursor(ctx, 'zaps', 'engagement');
    // Same per-filter discipline: replies/reposts, zap receipts and likes
    // each get their own limit window so one flood cannot starve the others.
    this.inboxPromise = this.sweep(
      this.relays(),
      [
        { kinds: [1, 6, 1111], '#p': [ctx.pubkey], limit: SWEEP_PAGE_LIMIT },
        { kinds: [9735], '#p': [ctx.pubkey], limit: SWEEP_PAGE_LIMIT },
        { kinds: [7], '#p': [ctx.pubkey], limit: SWEEP_PAGE_LIMIT },
      ],
      since,
      'inbox'
    ).then(events => {
      this.inboxEvents = events;
      return events;
    });
    return this.inboxPromise;
  }

  /** Sweep 3: sent zaps (zap receipts whose P tag is me — best effort). */
  public sentZaps(ctx: RunContext): Promise<NostrEvent[]> {
    if (this.sentZapsEvents) return Promise.resolve(this.sentZapsEvents);
    if (this.sentZapsPromise) return this.sentZapsPromise;

    const since = ctx.fullRun ? undefined : this.cursor(ctx, 'zaps');
    this.sentZapsPromise = this.sweep(
      this.relays(),
      [{ kinds: [9735], '#P': [ctx.pubkey], limit: SWEEP_PAGE_LIMIT }],
      since,
      'sent-zaps'
    ).then(events => {
      this.sentZapsEvents = events;
      return events;
    });
    return this.sentZapsPromise;
  }

  /** Max previous cursor across the given collectors (shared-sweep basis). */
  private cursor(ctx: RunContext, ...ids: CollectorId[]): number | undefined {
    let max = 0;
    let any = false;
    for (const id of ids) {
      const prev = ctx.previous(id);
      if (prev && prev.sinceCursor > max) {
        max = prev.sinceCursor;
        any = true;
      }
    }
    return any ? max + 1 : undefined; // +1: relay `since` is inclusive
  }

  /**
   * Paginated sweep with straggler tolerance:
   *
   * Runs in the transport's fast QUORUM mode (a round resolves once ~60% of
   * relays answered + 1s grace — never waits the full timeout on slow ones).
   * The quorum mode's blind spot for COUNTING sweeps — a relay that did not
   * answer in time reports count 0 and used to be misread as "exhausted,
   * never page again" — is fixed here via the per-relay `eosed` flag:
   *
   *   - eosed + count < limit  -> genuinely exhausted, drop from paging
   *   - eosed + count >= limit -> advance its until-cursor, keep paging
   *   - !eosed (straggler)     -> KEEP its previous cursor and re-ask next
   *                               round; after 2 consecutive misses, drop it
   *
   * Global dedupe by event id; hard page cap bounds the total relay load.
   */
  private async sweep(
    relays: string[],
    baseFilters: NDKFilter[],
    since: number | undefined,
    name: string
  ): Promise<NostrEvent[]> {
    const collected: NostrEvent[] = [];
    const seen = new Set<string>();
    const pending = new Set(relays);
    const cursors: Record<string, number> = {};
    const missedRounds = new Map<string, number>();
    const t0 = Date.now();
    let pages = 0;

    for (; pages < SWEEP_MAX_PAGES && pending.size > 0; pages++) {
      const activeRelays = [...pending];
      const roundCursors: Record<string, number> = {};
      for (const relay of activeRelays) {
        if (cursors[relay] !== undefined) roundCursors[relay] = cursors[relay];
      }

      const filters = baseFilters.map(f =>
        since !== undefined ? { ...f, since } : f
      );
      const { events, perRelay } = await this.transport.fetchDirectPaged(
        activeRelays,
        filters,
        roundCursors,
        SWEEP_TIMEOUT_MS,
        `Analytics-${name}`
      );

      for (const ev of events) {
        if (ev.id && !seen.has(ev.id)) {
          seen.add(ev.id);
          collected.push(ev);
        }
      }

      for (const relay of activeRelays) {
        const info = perRelay[relay];
        if (!info) {
          pending.delete(relay);
          continue;
        }
        if (info.eosed) {
          missedRounds.delete(relay);
          if (info.count >= SWEEP_PAGE_LIMIT && info.oldest !== null) {
            cursors[relay] = info.oldest;
          } else {
            pending.delete(relay);
          }
        } else {
          const misses = (missedRounds.get(relay) ?? 0) + 1;
          if (misses >= 2) {
            pending.delete(relay);
            diagLog('addons', 'analytics: straggler relay dropped', {
              sweep: name,
              relay,
              misses,
            });
          } else {
            missedRounds.set(relay, misses);
          }
        }
      }
    }

    diagLog('addons', 'analytics: sweep finished', {
      sweep: name,
      events: collected.length,
      since: since ?? null,
      pages,
      relays: relays.length,
      durationMs: Date.now() - t0,
    });
    return collected;
  }
}

// ─── Collectors ──────────────────────────────────────────────────────────

/** Posts row: originals vs replies/comments + quotient (plan P2). */
const postsCollector: AnalyticsCollector = {
  id: 'posts',
  async collect(ctx: RunContext): Promise<CollectorSnapshot> {
    const events = await ctx.sweeps.ownContent(ctx);
    const classification = classifyOwnContent(asLogic(events));
    const prev = ctx.previous('posts');

    if (!ctx.fullRun && prev) {
      const merged = mergeOwnContent(
        {
          posts: prev.metrics as never,
          content: {} as never,
          ownEventIds: prev.aux?.ownEventIds ?? [],
        },
        classification
      );
      return {
        collectorId: 'posts',
        metrics: merged.posts as unknown as Record<string, number>,
        sinceCursor: Math.max(prev.sinceCursor, classification.maxCreatedAt),
        fetchedAt: Date.now(),
        aux: { ownEventIds: [...merged.ownEventIds] },
      };
    }

    return {
      collectorId: 'posts',
      metrics: classification.posts as unknown as Record<string, number>,
      sinceCursor: classification.maxCreatedAt,
      fetchedAt: Date.now(),
      aux: { ownEventIds: [...classification.ownEventIds] },
    };
  },
};

/**
 * Follow row: follows (local, instant) + followers (shared PV cache, P3).
 *
 * The follower count streams progressively (PV semantics): each relay batch
 * emits `analytics:followers-progress` so the tile shows `N+` pulsating while
 * the sweep runs, and the final section-ready settles the plain number. No
 * artificial timeout — the collector awaits the shared FollowerCountService
 * exactly as the ProfileView does (warm cache resolves instantly).
 */
const followCollector: AnalyticsCollector = {
  id: 'follow',
  async collect(ctx: RunContext): Promise<CollectorSnapshot> {
    const follows = await FollowCheckService.getInstance().getFollowCount();

    const profileApi =
      ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile');
    let followers: number | undefined;
    if (profileApi) {
      try {
        followers = await profileApi.getFollowerCount(ctx.pubkey, count =>
          TypedEventBus.getInstance().emit('analytics:followers-progress', {
            count,
          })
        );
      } catch (err) {
        diagLog('addons', 'analytics: follower count unavailable', {
          error: String(err),
        });
      }
    }

    return {
      collectorId: 'follow',
      metrics: followers === undefined ? { follows } : { follows, followers },
      sinceCursor: 0,
      fetchedAt: Date.now(),
    };
  },
};

/** Content row: articles / videos / listings (plan P4, shared sweep 1). */
const contentCollector: AnalyticsCollector = {
  id: 'content',
  async collect(ctx: RunContext): Promise<CollectorSnapshot> {
    const events = await ctx.sweeps.ownContent(ctx);
    const classification = classifyOwnContent(asLogic(events));
    const prev = ctx.previous('content');

    if (!ctx.fullRun && prev) {
      const merged = mergeOwnContent(
        {
          posts: {} as never,
          content: prev.metrics as never,
          ownEventIds: prev.aux?.ownEventIds ?? [],
        },
        classification
      );
      return {
        collectorId: 'content',
        metrics: merged.content as unknown as Record<string, number>,
        sinceCursor: Math.max(prev.sinceCursor, classification.maxCreatedAt),
        fetchedAt: Date.now(),
      };
    }

    return {
      collectorId: 'content',
      metrics: classification.content as unknown as Record<string, number>,
      sinceCursor: classification.maxCreatedAt,
      fetchedAt: Date.now(),
    };
  },
};

/** Zaps row: counts + sums + ratio (plan P5; sent via #P is best effort). */
const zapsCollector: AnalyticsCollector = {
  id: 'zaps',
  async collect(ctx: RunContext): Promise<CollectorSnapshot> {
    const [inbox, sent] = await Promise.all([
      ctx.sweeps.inbox(ctx),
      ctx.sweeps.sentZaps(ctx),
    ]);
    const receivedClass = classifyInbox(asLogic(inbox), new Set());
    const sentClass = classifySentZaps(asLogic(sent));
    const metrics = computeZapsMetrics(sentClass, receivedClass.zapsReceived);
    const cursor = Math.max(receivedClass.maxCreatedAt, sentClass.maxCreatedAt);
    const prev = ctx.previous('zaps');

    if (!ctx.fullRun && prev) {
      const merged: Record<string, number> = mergeCounts(
        { ...prev.metrics, satsRatio: 0 },
        { ...metrics, satsRatio: 0 }
      );
      // Ratio is derived — recompute from the merged sums, never add it.
      merged.satsRatio = computeZapsMetrics(
        { count: merged.sentCount ?? 0, sats: merged.sentSats ?? 0 },
        { count: merged.receivedCount ?? 0, sats: merged.receivedSats ?? 0 }
      ).satsRatio;
      return {
        collectorId: 'zaps',
        metrics: merged,
        sinceCursor: Math.max(prev.sinceCursor, cursor),
        fetchedAt: Date.now(),
      };
    }

    return {
      collectorId: 'zaps',
      metrics: metrics as unknown as Record<string, number>,
      sinceCursor: cursor,
      fetchedAt: Date.now(),
    };
  },
};

/**
 * Engagement row: replies/reposts/quotes received with STRICT validation
 * against the own-event-id set (plan decision 2026-08-27). Requires the
 * posts snapshot (persisted aux ids) — the sequential collector order
 * guarantees posts ran first.
 */
const engagementCollector: AnalyticsCollector = {
  id: 'engagement',
  async collect(ctx: RunContext): Promise<CollectorSnapshot> {
    const [inbox, ownEvents] = await Promise.all([
      ctx.sweeps.inbox(ctx),
      ctx.sweeps.ownContent(ctx),
    ]);

    // Own-id basis: persisted ids from the previous posts snapshot, overlaid
    // with the ids this run's own-content sweep already classified.
    const prevPosts = ctx.previous('posts');
    const ownIds = new Set<string>(prevPosts?.aux?.ownEventIds ?? []);
    for (const ev of ownEvents) {
      if (ev.kind !== 5 && ev.id) ownIds.add(ev.id);
    }

    const classification = classifyInbox(asLogic(inbox), ownIds);
    const prev = ctx.previous('engagement');

    if (!ctx.fullRun && prev) {
      return {
        collectorId: 'engagement',
        metrics: mergeCounts(prev.metrics, {
          ...classification.engagement,
        } as unknown as Record<string, number>),
        sinceCursor: Math.max(prev.sinceCursor, classification.maxCreatedAt),
        fetchedAt: Date.now(),
      };
    }

    return {
      collectorId: 'engagement',
      metrics: classification.engagement as unknown as Record<string, number>,
      sinceCursor: classification.maxCreatedAt,
      fetchedAt: Date.now(),
    };
  },
};

/**
 * Top posts row (P8): the user's own original posts ranked by the criteria
 * tree Replies > Zaps > Reposts/Quotes > Likes (compareTopPosts). Shares both
 * sweeps via the SweepCache — zero extra relay load. The ranked list lives in
 * the snapshot aux (capped at 20); incremental deltas tally against the
 * previous list, drift outside the cap heals on a full run.
 */
const topPostsCollector: AnalyticsCollector = {
  id: 'top-posts',
  async collect(ctx: RunContext): Promise<CollectorSnapshot> {
    const [ownEvents, inbox] = await Promise.all([
      ctx.sweeps.ownContent(ctx),
      ctx.sweeps.inbox(ctx),
    ]);
    const ownLogic = asLogic(ownEvents);
    const inboxLogic = asLogic(inbox);

    const { posts, deletedIds } = extractOwnPosts(ownLogic);
    const tallies = tallyInboxByTarget(inboxLogic);
    const prev = ctx.previous('top-posts');
    const prevPosts = !ctx.fullRun && prev ? (prev.aux?.topPosts ?? []) : [];
    const topPosts = mergeTopPosts(prevPosts, posts, tallies, deletedIds);

    let cursor = prev?.sinceCursor ?? 0;
    for (const ev of ownLogic) cursor = Math.max(cursor, ev.created_at);
    for (const ev of inboxLogic) cursor = Math.max(cursor, ev.created_at);

    return {
      collectorId: 'top-posts',
      metrics: {},
      sinceCursor: cursor,
      fetchedAt: Date.now(),
      aux: { topPosts },
    };
  },
};

/**
 * Engagement timeline (P9, Diagrams tab): received engagement per time
 * bucket, bucket unit adaptive to the account age. Shares both sweeps via
 * the SweepCache — zero extra relay load. Buckets merge additively by their
 * UTC-aligned start; a unit change between runs restarts the curve from the
 * delta (heals on Refresh).
 */
const engagementTimelineCollector: AnalyticsCollector = {
  id: 'engagement-timeline',
  async collect(ctx: RunContext): Promise<CollectorSnapshot> {
    const [ownEvents, inbox, sent] = await Promise.all([
      ctx.sweeps.ownContent(ctx),
      ctx.sweeps.inbox(ctx),
      ctx.sweeps.sentZaps(ctx),
    ]);
    const ownLogic = asLogic(ownEvents);
    const inboxLogic = asLogic(inbox);
    const sentLogic = asLogic(sent);

    // Own-id basis: persisted ids from the previous posts snapshot, overlaid
    // with the ids this run's own-content sweep already classified.
    const prevPosts = ctx.previous('posts');
    const ownIds = new Set<string>(prevPosts?.aux?.ownEventIds ?? []);
    for (const ev of ownEvents) {
      if (ev.kind !== 5 && ev.id) ownIds.add(ev.id);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let oldest = nowSec;
    for (const ev of ownLogic) {
      if (ev.kind !== 5 && ev.created_at < oldest) oldest = ev.created_at;
    }
    const prev = ctx.previous('engagement-timeline');
    // Incremental sweeps only carry NEW own events — the account-age basis
    // must come from the persisted oldest event, or the unit would reset to
    // 'day' on every incremental run and wipe the curve (2026-08-29 bug).
    if (!ctx.fullRun && prev?.aux?.oldestOwnEventAt) {
      oldest = Math.min(oldest, prev.aux.oldestOwnEventAt);
    }
    const unit = pickEngagementUnit(oldest, nowSec);

    const delta = bucketEngagementTimeline(inboxLogic, ownIds, unit);
    const sentDelta = bucketSentZaps(sentLogic, unit);
    const unitStable = !ctx.fullRun && prev?.aux?.timelineUnit === unit;
    const prevTimeline = unitStable ? (prev?.aux?.timeline ?? []) : [];
    const timeline = mergeEngagementTimeline(prevTimeline, delta);
    const prevSent = unitStable ? (prev?.aux?.sentZapsTimeline ?? []) : [];
    const sentZapsTimeline = mergeEngagementTimeline(prevSent, sentDelta);

    let cursor = prev?.sinceCursor ?? 0;
    for (const ev of inboxLogic) cursor = Math.max(cursor, ev.created_at);
    for (const ev of sentLogic) cursor = Math.max(cursor, ev.created_at);

    return {
      collectorId: 'engagement-timeline',
      metrics: {},
      sinceCursor: cursor,
      fetchedAt: Date.now(),
      aux: {
        timeline,
        timelineUnit: unit,
        oldestOwnEventAt: oldest,
        sentZapsTimeline,
      },
    };
  },
};

/**
 * All active collectors — sequential run order matters:
 * posts FIRST (builds the own-event-id set engagement validates against),
 * follow LAST (its follower count is a long relay sweep owned by the
 * profile module — it must not delay the faster collectors; it streams
 * progress while running and bounds the run's tail).
 */
export const COLLECTORS: AnalyticsCollector[] = [
  postsCollector,
  contentCollector,
  zapsCollector,
  engagementCollector,
  topPostsCollector,
  engagementTimelineCollector,
  followCollector,
];
