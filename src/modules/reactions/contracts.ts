import type { InteractionStats, DetailedStats } from '../../services/orchestration/ReactionsOrchestrator';

export type { InteractionStats, DetailedStats };

export interface ReactionsModuleApi {
  getStats(noteId: string, authorPubkey?: string, eventId?: string): Promise<InteractionStats>;
  getCachedStats(noteId: string): InteractionStats | null;
  getDetailedStats(noteId: string, eventId?: string): Promise<DetailedStats>;
  updateCachedStats(noteId: string, updates: Partial<InteractionStats>): void;
  clearCache(noteId: string): void;
  startLiveReactions(noteId: string, callback: (stats: InteractionStats) => void, options?: { interval?: number; authorPubkey?: string; eventId?: string }): void;
  stopLiveReactions(noteId: string): void;
  hasUserLiked(noteId: string): Promise<boolean>;
  hasUserLikedWithEmoji(noteId: string, emoji: string): Promise<boolean>;
  publishReaction(options: { noteId: string; authorPubkey: string; emoji?: string; eventId?: string }): Promise<{ success: boolean; alreadyLiked?: boolean; error?: string }>;
}
