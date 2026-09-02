/**
 * Regression tests for the like-flow cache-wipe bug:
 *
 * StatsUpdateService.updateAfterInteraction used to call
 * ReactionsOrchestrator.clearCache(noteId) ("invalidate to force fresh
 * data"). With the live-stats subscription that is DESTRUCTIVE: the echo of
 * the user's own reaction rebuilt the cache via create-if-missing with ONLY
 * the own event — wiping every existing reaction from the .like-list until
 * the next full refetch.
 *
 * Contract now:
 * - updateAfterInteraction NEVER clears the cache.
 * - A cache rebuilt by the live-stats create-if-missing path is marked
 *   UNFRESH (lastUpdated: 0) so the next getDetailedStats performs a full
 *   refetch and heals wiped data within seconds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { orchestratorMock } = vi.hoisted(() => ({
  orchestratorMock: {
    clearCache: vi.fn(),
    clearAllCache: vi.fn(),
  },
}));

vi.mock('./orchestration/ReactionsOrchestrator', () => ({
  ReactionsOrchestrator: { getInstance: () => orchestratorMock },
}));

import { StatsUpdateService } from './StatsUpdateService';

describe('StatsUpdateService.updateAfterInteraction (like-flow cache wipe regression)', () => {
  beforeEach(() => {
    orchestratorMock.clearCache.mockClear();
    (
      StatsUpdateService as unknown as { instance: StatsUpdateService | null }
    ).instance = null;
  });

  it('like: does NOT clear the detailed-stats cache', () => {
    const svc = StatsUpdateService.getInstance();
    svc.updateAfterInteraction('a'.repeat(64), 'like');
    expect(orchestratorMock.clearCache).not.toHaveBeenCalled();
  });

  it('repost: does NOT clear the detailed-stats cache', () => {
    const svc = StatsUpdateService.getInstance();
    svc.updateAfterInteraction('a'.repeat(64), 'repost');
    expect(orchestratorMock.clearCache).not.toHaveBeenCalled();
  });

  it('quotedRepost: does NOT clear the detailed-stats cache', () => {
    const svc = StatsUpdateService.getInstance();
    svc.updateAfterInteraction('a'.repeat(64), 'quotedRepost');
    expect(orchestratorMock.clearCache).not.toHaveBeenCalled();
  });
});
