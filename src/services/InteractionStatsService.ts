/**
 * InteractionStatsService
 * Thin wrapper around ReactionsOrchestrator for backwards compatibility
 * All logic now in ReactionsOrchestrator
 */

import { ReactionsOrchestrator } from './orchestration/ReactionsOrchestrator';

export interface InteractionStats {
  replies: number;
  reposts: number; // Regular reposts (kind 6 without 'q' tag)
  quotedReposts: number; // Quoted reposts (kind 6 with 'q' tag)
  likes: number; // Reactions (kind 7 with content '+')
  zaps: number; // Zap receipts (kind 9735)
  lastUpdated: number;
}

export class InteractionStatsService {
  private static instance: InteractionStatsService;
  private orchestrator: ReactionsOrchestrator;

  private constructor() {
    this.orchestrator = ReactionsOrchestrator.getInstance();
  }

  public static getInstance(): InteractionStatsService {
    if (!InteractionStatsService.instance) {
      InteractionStatsService.instance = new InteractionStatsService();
    }
    return InteractionStatsService.instance;
  }

  /**
   * Get stats for a note (delegates to ReactionsOrchestrator)
   * @param noteId - The note ID to fetch stats for
   * @param authorPubkey - Optional author pubkey for Hollywood-style logging
   */
  public async getStats(
    noteId: string,
    authorPubkey?: string
  ): Promise<InteractionStats> {
    return this.orchestrator.getStats(noteId, authorPubkey);
  }

  /**
   * Get cached stats for a note (without fetching)
   * Returns null if not in cache or expired
   * Used by Timeline to show previously-fetched stats from SNV
   */
  public getCachedStats(noteId: string): InteractionStats | null {
    return this.orchestrator.getCachedStats(noteId);
  }

  /**
   * Update cached stats for a note (used by SNV to correct reply count)
   */
  public updateCachedStats(
    noteId: string,
    updates: Partial<InteractionStats>
  ): void {
    this.orchestrator.updateCachedStats(noteId, updates);
  }

  /**
   * Clear cached stats for a note
   */
  public clearCache(noteId: string): void {
    this.orchestrator.clearCache(noteId);
  }

  /**
   * Clear all cached stats
   */
  public clearAllCache(): void {
    this.orchestrator.clearAllCache();
  }
}
