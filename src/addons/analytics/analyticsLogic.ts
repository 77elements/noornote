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
  /** Raw event content — only needed by the Top-Posts extraction (P8). */
  content?: string;
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

// ─── Top posts (P8) ──────────────────────────────────────────────────────

/** Minimal own-post info extracted from the own-content sweep. */
export interface OwnPostInfo {
  id: string;
  createdAt: number;
  content: string;
}

/** One own post with its per-post engagement tallies (Top-Posts list entry). */
export interface TopPostEntry extends OwnPostInfo {
  replies: number;
  /** Zap receipt count attributed to this post. */
  zaps: number;
  zapSats: number;
  /** Kind 6 without q-tag targeting this post. */
  reposts: number;
  /** Kind 6 with q-tag quoting this post. */
  quotes: number;
  /** Kind 7 likes targeting this post. */
  likes: number;
}

/** Per-target engagement tallies derived from one inbox batch. */
export interface TargetTally {
  replies: number;
  zaps: number;
  zapSats: number;
  reposts: number;
  quotes: number;
  likes: number;
}

const emptyTally = (): TargetTally => ({
  replies: 0,
  zaps: 0,
  zapSats: 0,
  reposts: 0,
  quotes: 0,
  likes: 0,
});

/** How many entries the top-posts snapshot keeps (view shows the top 10). */
export const TOP_POSTS_CAP = 20;

/**
 * Extract the user's own original kind-1 posts (no e-tag) with their content,
 * excluding events deleted in this batch. Same "original" definition as
 * classifyOwnContent — keep the two in sync.
 */
export function extractOwnPosts(events: LogicEvent[]): {
  posts: OwnPostInfo[];
  deletedIds: Set<string>;
} {
  const deletedIds = new Set<string>();
  for (const ev of events) {
    if (ev.kind === 5) {
      for (const tag of ev.tags) {
        if (tag[0] === 'e' && typeof tag[1] === 'string')
          deletedIds.add(tag[1]);
      }
    }
  }
  const posts: OwnPostInfo[] = [];
  for (const ev of events) {
    if (
      ev.kind === 1 &&
      !hasTag(ev.tags, 'e') &&
      ev.id &&
      !deletedIds.has(ev.id)
    ) {
      posts.push({
        id: ev.id,
        createdAt: ev.created_at,
        content: ev.content ?? '',
      });
    }
  }
  return { posts, deletedIds };
}

/**
 * Tally inbox engagement per TARGET event id (e-tag for replies/zaps/likes/
 * reposts, q-tag for quotes). Mirrors classifyInbox semantics; zap receipts
 * without an e-tag stay unattributed (they count in the zaps row only).
 */
export function tallyInboxByTarget(
  events: LogicEvent[]
): Map<string, TargetTally> {
  const byTarget = new Map<string, TargetTally>();
  const tallyOf = (id: string): TargetTally => {
    let t = byTarget.get(id);
    if (!t) {
      t = emptyTally();
      byTarget.set(id, t);
    }
    return t;
  };
  for (const ev of events) {
    switch (ev.kind) {
      case 1:
      case 1111: {
        const e = firstTagValue(ev.tags, 'e');
        if (e) tallyOf(e).replies++;
        break;
      }
      case 6: {
        const q = firstTagValue(ev.tags, 'q');
        if (q) tallyOf(q).quotes++;
        else {
          const e = firstTagValue(ev.tags, 'e');
          if (e) tallyOf(e).reposts++;
        }
        break;
      }
      case 9735: {
        const e = firstTagValue(ev.tags, 'e');
        if (e) {
          tallyOf(e).zaps++;
          tallyOf(e).zapSats += getZapAmountSats(ev);
        }
        break;
      }
      case 7: {
        const e = firstTagValue(ev.tags, 'e');
        if (e) tallyOf(e).likes++;
        break;
      }
    }
  }
  return byTarget;
}

/** Rang-Kriterienbaum (User-Vorgabe): Replies > Zaps > Reposts/Quotes > Likes. */
export function compareTopPosts(a: TopPostEntry, b: TopPostEntry): number {
  if (a.replies !== b.replies) return b.replies - a.replies;
  if (a.zaps !== b.zaps) return b.zaps - a.zaps;
  const engagedA = a.reposts + a.quotes;
  const engagedB = b.reposts + b.quotes;
  if (engagedA !== engagedB) return engagedB - engagedA;
  if (a.likes !== b.likes) return b.likes - a.likes;
  return b.createdAt - a.createdAt;
}

function zeroTopPost(post: OwnPostInfo): TopPostEntry {
  return {
    id: post.id,
    createdAt: post.createdAt,
    content: post.content,
    replies: 0,
    zaps: 0,
    zapSats: 0,
    reposts: 0,
    quotes: 0,
    likes: 0,
  };
}

/**
 * Merge previous top-post entries with this run's own posts and engagement
 * tallies (additive, kumulativ — same merge philosophy as the other rows),
 * then re-rank and cap. Deleted posts drop out. Posts outside the cap lose
 * their tallies (documented drift, healed by a full run / Refresh).
 */
export function mergeTopPosts(
  prev: TopPostEntry[],
  ownPosts: OwnPostInfo[],
  tallies: Map<string, TargetTally>,
  deletedIds: ReadonlySet<string>,
  cap: number = TOP_POSTS_CAP
): TopPostEntry[] {
  const byId = new Map<string, TopPostEntry>();
  for (const entry of prev) {
    if (!deletedIds.has(entry.id)) byId.set(entry.id, { ...entry });
  }
  for (const post of ownPosts) {
    if (deletedIds.has(post.id) || byId.has(post.id)) continue;
    byId.set(post.id, zeroTopPost(post));
  }
  for (const [id, delta] of tallies) {
    const entry = byId.get(id);
    if (!entry) continue;
    entry.replies += delta.replies;
    entry.zaps += delta.zaps;
    entry.zapSats += delta.zapSats;
    entry.reposts += delta.reposts;
    entry.quotes += delta.quotes;
    entry.likes += delta.likes;
  }
  return [...byId.values()].sort(compareTopPosts).slice(0, cap);
}
