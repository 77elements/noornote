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
import { NoteUI } from '../../ui/NoteUI';

export class ISLStatsUpdater {
  private container: HTMLElement;
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return (this._reactionsApi ??=
      ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions'));
  }
  private fetchedNoteIds = new Set<string>();

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Update all ISL instances with cached stats
   * Called when returning to timeline after visiting SNV
   */
  updateFromCache(events: NostrEvent[]): void {
    events.forEach(event => {
      const noteIdForStats = extractOriginalNoteId(event);
      if (!noteIdForStats) return;

      const cachedStats =
        this.reactionsApi?.getCachedStats(noteIdForStats) ?? null;
      if (cachedStats) {
        const islElement = this.container.querySelector(
          `.isl[data-note-id="${noteIdForStats}"]`
        ) as HTMLElement;
        if (islElement) {
          const repliesCount = islElement.querySelector(
            '.isl-reply .isl-count'
          );
          const repostsCount = islElement.querySelector(
            '.isl-repost .isl-count'
          );
          const quotedRepostsCount = islElement.querySelector(
            '.isl-quote .isl-count'
          );
          const likesCount = islElement.querySelector('.isl-like .isl-count');
          const zapsCount = islElement.querySelector('.isl-zap .isl-count');

          if (repliesCount)
            repliesCount.textContent = formatCount(cachedStats.replies);
          if (repostsCount)
            repostsCount.textContent = formatCount(cachedStats.reposts);
          if (quotedRepostsCount)
            quotedRepostsCount.textContent = formatCount(
              cachedStats.quotedReposts
            );
          if (likesCount)
            likesCount.textContent = formatCount(cachedStats.likes);
          if (zapsCount) zapsCount.textContent = formatCount(cachedStats.zaps);
        }
      }
    });
  }

  /**
   * Batch-fetch stats from relays for rendered notes, then update ISL instances.
   * Skips notes that were already fetched in this timeline session.
   */
  async fetchAndUpdateStats(events: NostrEvent[]): Promise<void> {
    const noteIds: string[] = [];
    for (const event of events) {
      const id = extractOriginalNoteId(event);
      if (id && !this.fetchedNoteIds.has(id)) {
        noteIds.push(id);
      }
    }
    if (noteIds.length === 0) return;

    const chunks = [];
    for (let i = 0; i < noteIds.length; i += 25) {
      chunks.push(noteIds.slice(i, i + 25));
    }

    await Promise.all(
      chunks.map(async chunk => {
        const statsMap = await this.reactionsApi?.batchFetchStats(chunk);
        if (!statsMap) return;

        for (const [noteId, stats] of statsMap) {
          this.fetchedNoteIds.add(noteId);
          const isl = NoteUI.getInteractionStatusLine(noteId);
          if (isl) {
            isl.updateStats({
              replies: stats.replies,
              reposts: stats.reposts,
              quotedReposts: stats.quotedReposts,
              likes: stats.likes,
              zaps: stats.zaps,
            });
          }
        }
      })
    );
  }

  resetFetchedIds(): void {
    this.fetchedNoteIds.clear();
  }
}
