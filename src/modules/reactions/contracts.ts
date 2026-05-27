import type { InteractionStats, DetailedStats } from '../../services/orchestration/ReactionsOrchestrator';
import type { InteractionStatusLine } from '../../components/ui/InteractionStatusLine';
import type { StatsUpdateType } from '../../services/StatsUpdateService';

export type { InteractionStats, DetailedStats, StatsUpdateType };

export interface ReactionsModuleApi {
  getStats(noteId: string, authorPubkey?: string, eventId?: string): Promise<InteractionStats>;
  batchFetchStats(noteIds: string[]): Promise<Map<string, InteractionStats>>;
  getCachedStats(noteId: string): InteractionStats | null;
  getDetailedStats(noteId: string, eventId?: string): Promise<DetailedStats>;
  updateCachedStats(noteId: string, updates: Partial<InteractionStats>): void;
  clearCache(noteId: string): void;
  startLiveReactions(noteId: string, callback: (stats: InteractionStats) => void, options?: { interval?: number; authorPubkey?: string; eventId?: string }): void;
  stopLiveReactions(noteId: string): void;
  resetFetchCounter(): void;
  hasUserLiked(noteId: string): Promise<boolean>;
  hasUserLikedWithEmoji(noteId: string, emoji: string): Promise<boolean>;
  publishReaction(options: { noteId: string; authorPubkey: string; emoji?: string; eventId?: string }): Promise<{ success: boolean; alreadyLiked?: boolean; error?: string }>;

  // StatsUpdateService
  updateAfterInteraction(noteId: string, type: StatsUpdateType, islComponent?: InteractionStatusLine): void;
  clearCacheOnly(noteId: string): void;
}
