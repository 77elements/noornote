/**
 * ISLStatsUpdater - Updates ISL stats from cache
 * Updates interaction stats in DOM when returning from SNV (where stats were fetched)
 * Extracts from: TimelineUI.updateISLWithCachedStats()
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { ReactionsModuleApi } from '../../../modules/reactions/contracts';
import { extractOriginalNoteId } from '../../../helpers/extractOriginalNoteId';
import { formatCount } from '../../../helpers/formatCount';

export class ISLStatsUpdater {
  private container: HTMLElement;
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return this._reactionsApi ??= ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
  }

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Update all ISL instances with cached stats
   * Called when returning to timeline after visiting SNV
   */
  updateFromCache(events: NostrEvent[]): void {
    events.forEach(event => {
      // Extract original note ID (for reposts, gets the reposted note ID)
      const noteIdForStats = extractOriginalNoteId(event);
      if (!noteIdForStats) return;

      const cachedStats = this.reactionsApi?.getCachedStats(noteIdForStats) ?? null;
      if (cachedStats) {
        // Find ISL element in DOM (not via Map, as SNV may have overwritten it)
        const islElement = this.container.querySelector(`.isl[data-note-id="${noteIdForStats}"]`) as HTMLElement;
        if (islElement) {
          // Update DOM directly
          const repliesCount = islElement.querySelector('.isl-reply .isl-count');
          const repostsCount = islElement.querySelector('.isl-repost .isl-count');
          const quotedRepostsCount = islElement.querySelector('.isl-quote .isl-count');
          const likesCount = islElement.querySelector('.isl-like .isl-count');
          const zapsCount = islElement.querySelector('.isl-zap .isl-count');

          if (repliesCount) repliesCount.textContent = formatCount(cachedStats.replies);
          if (repostsCount) repostsCount.textContent = formatCount(cachedStats.reposts);
          if (quotedRepostsCount) quotedRepostsCount.textContent = formatCount(cachedStats.quotedReposts);
          if (likesCount) likesCount.textContent = formatCount(cachedStats.likes);
          if (zapsCount) zapsCount.textContent = formatCount(cachedStats.zaps);
        }
      }
    });
  }
}
