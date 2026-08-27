/**
 * analyticsLogic — pure classification/merge logic for the Analytics addon.
 *
 * Deliberately free of heavy imports (no transport, no services): every
 * function is deterministically testable in the node test environment
 * (analyticsLogic.test.ts). Collectors feed raw (already fetched) events in
 * and get metrics out; merging previous snapshots with incremental deltas
 * lives here too (P6).
 */

import { getZapAmountSats } from '../../helpers/zapUtils';

/** Minimal event shape the logic needs (compatible with NDK's NostrEvent). */
export interface LogicEvent {
  id?: string;
  kind: number;
  tags: string[][];
  created_at: number;
}

export interface PostsMetrics {
  originals: number;
  repliesKind1: number;
  comments1111: number;
  repliesTotal: number;
  /** repliesTotal / originals; Infinity when replies exist but originals don't. */
  quotient: number;
}

export interface ContentMetrics {
  articles: number;
  videos: number;
  listings: number;
}

export interface EngagementMetrics {
  repliesReceived: number;
  repostsReceived: number;
  quotesReceived: number;
}

export interface ZapsMetrics {
  sentCount: number;
  sentSats: number;
  receivedCount: number;
  receivedSats: number;
  /** sentSats / receivedSats (0 when nothing received). */
  satsRatio: number;
}

/** Own-content kinds fetched by the own-content sweep (incl. kind 5 deletions). */
export const OWN_CONTENT_KINDS = [1, 1111, 30023, 21, 22, 30402, 5];

function firstTagValue(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === 'string') return tag[1];
  }
  return undefined;
}

function hasTag(tags: string[][], name: string): boolean {
  return tags.some(t => t[0] === name);
}

export interface OwnContentClassification {
  posts: PostsMetrics;
  content: ContentMetrics;
  /** Event ids of own non-deletion events (deleted ones already removed). */
  ownEventIds: Set<string>;
  /** Ids targeted by own kind-5 deletions in this batch (for incremental merges). */
  deletedIds: Set<string>;
  /** Highest created_at seen (0 when no events) — since-cursor basis. */
  maxCreatedAt: number;
}

/**
 * Classify the own-content sweep (kinds 1, 1111, 30023, 21, 22, 30402 + 5).
 * kind 5 deletions subtract from the per-kind counts (an author's deletion
 * targets their own events via e-tags).
 */
export function classifyOwnContent(
  events: LogicEvent[]
): OwnContentClassification {
  const originals: string[] = [];
  const repliesKind1: string[] = [];
  const comments1111: string[] = [];
  const articles: string[] = [];
  const videos: string[] = [];
  const listings: string[] = [];
  const deletedIds = new Set<string>();
  let maxCreatedAt = 0;

  for (const ev of events) {
    if (ev.created_at > maxCreatedAt) maxCreatedAt = ev.created_at;
    switch (ev.kind) {
      case 1:
        // Reply = kind 1 with an e-tag (root or reply marker both count);
        // pure mentions without e-tag are original notes.
        if (hasTag(ev.tags, 'e')) repliesKind1.push(ev.id ?? '');
        else originals.push(ev.id ?? '');
        break;
      case 1111:
        comments1111.push(ev.id ?? '');
        break;
      case 30023:
        articles.push(ev.id ?? '');
        break;
      case 21:
      case 22:
        videos.push(ev.id ?? '');
        break;
      case 30402:
        listings.push(ev.id ?? '');
        break;
      case 5:
        for (const tag of ev.tags) {
          if (tag[0] === 'e' && typeof tag[1] === 'string')
            deletedIds.add(tag[1]);
        }
        break;
    }
  }

  const alive = (ids: string[]): string[] => {
    const unique = [...new Set(ids.filter(id => id !== ''))];
    return unique.filter(id => !deletedIds.has(id));
  };

  const aliveOriginals = alive(originals);
  const aliveReplies = alive(repliesKind1);
  const aliveComments = alive(comments1111);
  const repliesTotal = aliveReplies.length + aliveComments.length;
  const originalsCount = aliveOriginals.length;

  const ownEventIds = new Set<string>([
    ...aliveOriginals,
    ...aliveReplies,
    ...aliveComments,
    ...alive(articles),
    ...alive(videos),
    ...alive(listings),
  ]);

  return {
    posts: {
      originals: originalsCount,
      repliesKind1: aliveReplies.length,
      comments1111: aliveComments.length,
      repliesTotal,
      quotient: computeQuotient(originalsCount, repliesTotal),
    },
    content: {
      articles: alive(articles).length,
      videos: alive(videos).length,
      listings: alive(listings).length,
    },
    ownEventIds,
    deletedIds,
    maxCreatedAt,
  };
}

export function computeQuotient(
  originals: number,
  repliesTotal: number
): number {
  if (originals === 0) return repliesTotal > 0 ? Number.POSITIVE_INFINITY : 0;
  return repliesTotal / originals;
}

export interface InboxClassification {
  engagement: EngagementMetrics;
  /** Zap receipts received within this batch. */
  zapsReceived: { count: number; sats: number };
  maxCreatedAt: number;
}

/**
 * Classify the inbox sweep (#p:me, kinds 1, 6, 1111, 9735) with STRICT
 * validation: a reply/repost/quote only counts when it references one of the
 * user's own event ids (e-tag for replies/reposts, q-tag for quotes).
 * Zap receipts (9735) always count — the #p filter already targeted us.
 */
export function classifyInbox(
  events: LogicEvent[],
  ownEventIds: ReadonlySet<string>
): InboxClassification {
  const engagement: EngagementMetrics = {
    repliesReceived: 0,
    repostsReceived: 0,
    quotesReceived: 0,
  };
  const zapsReceived = { count: 0, sats: 0 };
  let maxCreatedAt = 0;

  for (const ev of events) {
    if (ev.created_at > maxCreatedAt) maxCreatedAt = ev.created_at;
    switch (ev.kind) {
      case 1:
      case 1111: {
        const e = firstTagValue(ev.tags, 'e');
        if (e && ownEventIds.has(e)) engagement.repliesReceived++;
        break;
      }
      case 6: {
        const q = firstTagValue(ev.tags, 'q');
        if (q) {
          if (ownEventIds.has(q)) engagement.quotesReceived++;
        } else {
          const e = firstTagValue(ev.tags, 'e');
          if (e && ownEventIds.has(e)) engagement.repostsReceived++;
        }
        break;
      }
      case 9735: {
        zapsReceived.count++;
        zapsReceived.sats += getZapAmountSats(ev);
        break;
      }
    }
  }

  return { engagement, zapsReceived, maxCreatedAt };
}

/** Classify the sent-zaps sweep (#P:me, kind 9735). */
export function classifySentZaps(events: LogicEvent[]): {
  count: number;
  sats: number;
  maxCreatedAt: number;
} {
  let count = 0;
  let sats = 0;
  let maxCreatedAt = 0;
  for (const ev of events) {
    if (ev.created_at > maxCreatedAt) maxCreatedAt = ev.created_at;
    count++;
    sats += getZapAmountSats(ev);
  }
  return { count, sats, maxCreatedAt };
}

export function computeZapsMetrics(
  sent: { count: number; sats: number },
  received: { count: number; sats: number }
): ZapsMetrics {
  return {
    sentCount: sent.count,
    sentSats: sent.sats,
    receivedCount: received.count,
    receivedSats: received.sats,
    satsRatio: received.sats > 0 ? sent.sats / received.sats : 0,
  };
}

/**
 * Additive merge of two metric records (incremental runs, P6). Works for any
 * object of numeric fields (PostsMetrics, ContentMetrics, …) — non-numeric
 * fields must not be passed (callers zero out derived values like quotient
 * beforehand and recompute them after the merge).
 */
export function mergeCounts<T extends object>(prev: T, delta: Partial<T>): T {
  const out = { ...prev } as Record<string, unknown>;
  const deltaRecord = delta as Record<string, unknown>;
  for (const key of Object.keys(deltaRecord)) {
    const d = deltaRecord[key];
    const p = out[key];
    out[key] =
      (typeof p === 'number' ? p : 0) + (typeof d === 'number' ? d : 0);
  }
  return out as T;
}

/**
 * Merge an incremental own-content classification into the previous state.
 * Counts merge additively; delta deletions (which may target OLDER events)
 * are removed from the persisted id list — the numeric drift for old
 * deletions is accepted and healed by the next full run (Refresh).
 */
export function mergeOwnContent(
  prev: { posts: PostsMetrics; content: ContentMetrics; ownEventIds: string[] },
  delta: OwnContentClassification
): { posts: PostsMetrics; content: ContentMetrics; ownEventIds: Set<string> } {
  const mergedPrevIds = subtractIds(prev.ownEventIds, delta.deletedIds);
  const posts = mergeCounts(
    { ...prev.posts, quotient: 0 },
    { ...delta.posts, quotient: 0 }
  );
  const content = mergeCounts(prev.content, delta.content);
  posts.repliesTotal = posts.repliesKind1 + posts.comments1111;
  posts.quotient = computeQuotient(posts.originals, posts.repliesTotal);
  return {
    posts,
    content,
    ownEventIds: new Set([...mergedPrevIds, ...delta.ownEventIds]),
  };
}

/**
 * Remove ids from a persisted own-id list (deletions from an incremental
 * delta that target older events). Returns the filtered array.
 */
export function subtractIds(
  ids: string[],
  deleted: Iterable<string>
): string[] {
  const dead = deleted instanceof Set ? deleted : new Set(deleted);
  return ids.filter(id => !dead.has(id));
}
