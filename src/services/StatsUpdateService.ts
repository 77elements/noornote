/**
 * StatsUpdateService
 * Centralized service for updating interaction stats after user actions
 * Handles cache invalidation + optimistic UI updates
 *
 * Used by: Like, Repost, Quoted Repost actions
 */

import { ReactionsOrchestrator } from './orchestration/ReactionsOrchestrator';
import type { InteractionStatusLine } from '../components/ui/InteractionStatusLine';

export type StatsUpdateType = 'like' | 'repost' | 'quotedRepost';

export class StatsUpdateService {
  private static instance: StatsUpdateService;
  private reactionsOrchestrator: ReactionsOrchestrator;

  private constructor() {
    this.reactionsOrchestrator = ReactionsOrchestrator.getInstance();
  }

  public static getInstance(): StatsUpdateService {
    if (!StatsUpdateService.instance) {
      StatsUpdateService.instance = new StatsUpdateService();
    }
    return StatsUpdateService.instance;
  }

  /**
   * Update stats after successful user action
   *
   * @param noteId - ID of the note being interacted with
   * @param type - Type of interaction (like, repost, quotedRepost)
   * @param islComponent - Optional ISL component for optimistic UI update
   */
  public updateAfterInteraction(
    noteId: string,
    type: StatsUpdateType,
    islComponent?: InteractionStatusLine
  ): void {
    // Step 1: Invalidate cache to force fresh data from relays
    this.reactionsOrchestrator.clearCache(noteId);

    // Step 2: Optimistic UI update (if ISL component provided)
    if (islComponent) {
      switch (type) {
        case 'like':
          islComponent.updateStats({ likes: islComponent['stats'].likes + 1 });
          break;
        case 'repost':
          islComponent.updateStats({
            reposts: islComponent['stats'].reposts + 1,
          });
          break;
        case 'quotedRepost':
          islComponent.updateStats({
            quotedReposts: islComponent['stats'].quotedReposts + 1,
          });
          break;
      }
    }
  }

  /**
   * Clear cache only (for quoted reposts from PostNoteModal where no ISL exists)
   */
  public clearCacheOnly(noteId: string): void {
    this.reactionsOrchestrator.clearCache(noteId);
  }
}
