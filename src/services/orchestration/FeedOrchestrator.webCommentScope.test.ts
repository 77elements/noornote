/**
 * Wiring tests: web-comment (kind 1111 `#k: web`) filter scope in the
 * FeedOrchestrator's pollOnce catch-up path.
 *
 * Regression: the ProfileView new-posts poll queried the viewer's OWN web
 * comments (includeSelf defaulted to true), so an old self comment postdating
 * the profile's newest post surfaced as a bogus "new post from me" refresh
 * hint and was prepended into the foreign timeline. The includeOwnWebComments
 * flag must land in the ACTUAL relay filters, not just in the helper.
 *
 * Pattern: Object.create instance with all heavy deps injected/mocked
 * (no singleton, no transport/NDK, no IDB) — mirrors
 * OutboundRelaysOrchestrator.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as feedHarness from './feedOrchestratorTestHarness';

const SELF = 'f'.repeat(64);
const AUTHOR = 'a'.repeat(64);

vi.mock('../transport/NostrTransport', () => feedHarness.transportModule());

vi.mock('../AuthService', () => feedHarness.authServiceModule());

vi.mock('../SystemLogger', () => feedHarness.systemLoggerModule());

vi.mock('../DiagnosticLogger', () => feedHarness.diagnosticLoggerModule());

import { FeedOrchestrator } from './FeedOrchestrator';
import {
  CapturedFilter,
  feedTestState,
  makeOrchestrator,
  RELAY,
} from './feedOrchestratorTestHarness';

// Harness reads this lazily on getCurrentUser()
feedTestState.currentUser = SELF;

const transportFetch = feedTestState.transportFetch;

/** The authors array of the web-comment filter (2nd filter) in the last fetch. */
function lastWebCommentFilterAuthors(): string[] | undefined {
  const calls = transportFetch.mock.calls as unknown as [
    string[],
    CapturedFilter[],
  ][];
  const filters = calls[calls.length - 1]?.[1];
  return filters?.find(f => f.kinds?.includes(1111))?.authors;
}

beforeEach(() => {
  transportFetch.mockClear();
  transportFetch.mockImplementation(() => []);
});

describe('FeedOrchestrator pollOnce web-comment scope wiring', () => {
  it('excludes the viewer in author-scoped feeds (includeOwnWebComments=false)', async () => {
    const orch = makeOrchestrator(FeedOrchestrator);
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce(
      [AUTHOR],
      now - 60,
      true,
      RELAY,
      undefined,
      true,
      false
    );
    expect(lastWebCommentFilterAuthors()).toEqual([AUTHOR]);
  });

  it('includes the viewer in the following feed (includeOwnWebComments=true)', async () => {
    const orch = makeOrchestrator(FeedOrchestrator);
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce([AUTHOR], now - 60, true, RELAY, undefined, true, true);
    expect(lastWebCommentFilterAuthors()).toEqual([AUTHOR, SELF]);
  });

  it('defaults to include (legacy callers without the flag)', async () => {
    const orch = makeOrchestrator(FeedOrchestrator);
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce([AUTHOR], now - 60, true, RELAY, undefined, true);
    expect(lastWebCommentFilterAuthors()).toEqual([AUTHOR, SELF]);
  });
});
