import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type {
  InteractionStats,
  DetailedStats,
} from '../../services/orchestration/ReactionsOrchestrator';
import type { InteractionStatusLine } from '../../components/ui/InteractionStatusLine';
import type { StatsUpdateType } from '../../services/StatsUpdateService';

export type { InteractionStats, DetailedStats, StatsUpdateType };

export interface ReactionsModuleApi {
  getStats(
    noteId: string,
    authorPubkey?: string,
    eventId?: string
  ): Promise<InteractionStats>;
  batchFetchStats(noteIds: string[]): Promise<Map<string, InteractionStats>>;
  getCachedStats(noteId: string): InteractionStats | null;
  getDetailedStats(noteId: string, eventId?: string): Promise<DetailedStats>;
  /** Non-fetching cache read (any freshness) — instant UI, never blocks. */
  peekDetailedStats(noteId: string): DetailedStats | null;
  updateCachedStats(noteId: string, updates: Partial<InteractionStats>): void;
  clearCache(noteId: string): void;
  startLiveReactions(
    noteId: string,
    callback: (stats: InteractionStats) => void,
    options?: { interval?: number; authorPubkey?: string; eventId?: string }
  ): void;
  stopLiveReactions(noteId: string): void;
  /** Real-time interaction subscription (kinds 7/9735/6/16) — must be stopped via stopLiveStats (SNV teardown) */
  startLiveStats(
    noteId: string,
    onStats: (stats: InteractionStats) => void,
    onQuotedRepost?: (event: NostrEvent) => void
  ): void;
  stopLiveStats(noteId: string): void;
  resetFetchCounter(): void;
  hasUserLiked(noteId: string): Promise<boolean>;
  hasUserLikedWithEmoji(noteId: string, emoji: string): Promise<boolean>;
  publishReaction(options: {
    noteId: string;
    authorPubkey: string;
    emoji?: string;
    eventId?: string;
    targetEvent?: NostrEvent;
    emojiTag?: [string, string, string];
  }): Promise<{ success: boolean; alreadyLiked?: boolean; error?: string }>;
  /** Fetch the full reaction-on-reaction tree rooted at the given kind:7 event
   *  ids. Returns a map from a parent event-id to the kind:7 events that react
   *  to it (one hop per map entry; traverse recursively for the full tree). */
  fetchReactionTree(rootEventIds: string[]): Promise<Map<string, NostrEvent[]>>;
  /** Count kind:1111 comments replying to each given zap (kind:9735) event id,
   *  in one batched fetch. Returns zapId → count; zaps with no comments absent. */
  getZapReplyCounts(zapIds: string[]): Promise<Map<string, number>>;

  // StatsUpdateService
  updateAfterInteraction(
    noteId: string,
    type: StatsUpdateType,
    islComponent?: InteractionStatusLine
  ): void;
  clearCacheOnly(noteId: string): void;
}
