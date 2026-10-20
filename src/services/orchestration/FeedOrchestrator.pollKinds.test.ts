/**
 * Wiring tests: the show-reactions fetch gate in the polling paths.
 *
 * Regression: poll() and pollOnce() hardcoded `'following'` as the source
 * kind, so a ProfileView (source kind `authors`) polling its author fetched
 * kind-7 reactions whenever the show-reactions setting was on — followed
 * users' reactions surfaced as feed entries in the profile timeline. The
 * view's source kind must reach the actual relay filters, same wiring rule
 * as the web-comment scope tests (FeedOrchestrator.webCommentScope.test.ts).
 *
 * Pattern: Object.create instance with all heavy deps injected/mocked
 * (no singleton, no transport/NDK, no IDB).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as feedHarness from './feedOrchestratorTestHarness';

const AUTHOR = 'a'.repeat(64);

const { shouldFetchReactions } = vi.hoisted(() => ({
  shouldFetchReactions: vi.fn(() => true),
}));

vi.mock('../transport/NostrTransport', () => feedHarness.transportModule());

vi.mock('../AuthService', () => feedHarness.authServiceModule());

vi.mock('../SystemLogger', () => feedHarness.systemLoggerModule());

vi.mock('../DiagnosticLogger', () => feedHarness.diagnosticLoggerModule());

vi.mock('../../helpers/reactionsFeedSetting', () => ({
  shouldFetchReactions,
  isReactionShownFrom: () => true,
  getShowReactionsPubkeys: () => [],
}));

import { FeedOrchestrator } from './FeedOrchestrator';
import {
  allFilters,
  feedTestState,
  makeOrchestrator,
  RELAY,
} from './feedOrchestratorTestHarness';

// Harness reads this lazily on getCurrentUser()
feedTestState.currentUser = AUTHOR;

const transportFetch = feedTestState.transportFetch;

beforeEach(() => {
  transportFetch.mockClear();
  transportFetch.mockImplementation(() => []);
  shouldFetchReactions.mockImplementation(() => true);
});

describe('FeedOrchestrator pollOnce show-reactions scope wiring', () => {
  it('author-scoped view (PV): no kind-7 filter even with the setting on', async () => {
    const orch = makeOrchestrator(FeedOrchestrator);
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce(
      [AUTHOR],
      now - 60,
      true,
      RELAY,
      undefined,
      true,
      false,
      'authors'
    );
    expect(allFilters().some(f => f.kinds?.includes(7))).toBe(false);
  });

  it('following feed (TV): kind-7 filter present with the setting on', async () => {
    const orch = makeOrchestrator(FeedOrchestrator);
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce(
      [AUTHOR],
      now - 60,
      true,
      RELAY,
      undefined,
      true,
      true,
      'following'
    );
    expect(allFilters().some(f => f.kinds?.includes(7))).toBe(true);
  });

  it('legacy callers without a source kind get no kind-7 filter', async () => {
    const orch = makeOrchestrator(FeedOrchestrator);
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce([AUTHOR], now - 60, true, RELAY, undefined, true);
    expect(allFilters().some(f => f.kinds?.includes(7))).toBe(false);
  });
});
