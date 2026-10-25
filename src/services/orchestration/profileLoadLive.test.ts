/**
 * Manual live verification: profile feeds load for two known-post authors.
 *
 * Opt-in only — hits real relays and takes ~30–120 s. NOT part of CI:
 *
 *   RUN_LIVE_TESTS=1 ./node_modules/.bin/vitest run src/services/orchestration/profileLoadLive.test.ts
 *
 * Why it exists: the 1.9.2→1.9.3 regression (false "No events found" on
 * profiles with posts) was invisible to the entire unit suite — the mocked
 * transport obeyed whatever the orchestrator asked. Only a real fetch against
 * real relays catches the class of bug where the orchestration around the
 * transport is wrong (early empty-conclusion, quorum cuts, pagination exits).
 *
 * What's real: NostrTransport (NDK, pooled WebSockets), RelayConfig's standard
 * read relay set, OutboundRelaysOrchestrator relay discovery, and the
 * orchestrator's full PV path (loadInitialFeed → loadProfileDirect →
 * fetchDirectPaged rounds). What's mocked: only identity/mute/logging layers
 * that would drag the browser import graph into Node (cycles:
 * AuthService → lists/storage, SystemLogger → Router → components) — none of
 * them participate in the relay fetch itself.
 *
 * Skips itself silently when RUN_LIVE_TESTS is unset (CI + `bun run test`
 * never block on network).
 */
import { describe, it, expect, vi } from 'vitest';
import { nip19 } from 'nostr-tools';

// The user's two known-post authors (verified: both have plenty of posts).
const KNOWN_POSTERS = [
  'npub175nul9cvufswwsnpy99lvyhg7ad9nkccxhkhusznxfkr7e0zxthql9g6w0',
  'npub17veg2gt7ja4dnjhs23jyttvpqlde3ajevlxuumxwghnqmgqwuv4q78cc5z',
].map(n => nip19.decode(n).data as string);

const RUN_LIVE = process.env.RUN_LIVE_TESTS === '1';

// Node-safe import graph: identity, mute list and logging are mocked — the
// transport/orchestrator layers under test stay real.
vi.mock('../AuthService', () => ({
  AuthService: { getInstance: () => ({ getCurrentUser: () => null }) },
}));
vi.mock('../SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  },
}));
vi.mock('../DiagnosticLogger', () => ({ diagLog: vi.fn() }));
vi.mock('../../lists/mutes', () => ({
  MuteOrchestrator: {
    getInstance: () => ({
      getAllMutedUsers: () => [] as string[],
      getMutedUsers: () => new Set<string>(),
      isMuted: () => false,
    }),
  },
}));

describe.skipIf(!RUN_LIVE)('live profile load (manual, opt-in)', () => {
  it(
    'loads notes for both known-post authors over real relays',
    { timeout: 180_000 },
    async () => {
      // fake-indexeddb BEFORE NostrTransport: NDK's Dexie cache needs an
      // indexedDB global, which plain Node lacks. jsdom's localStorage is
      // available via the environment... but we run node-env, so polyfill
      // minimal storage globals BEFORE the transport module evaluates its
      // cache-migration block.
      const g = globalThis as unknown as Record<string, unknown>;
      if (typeof g.localStorage === 'undefined') {
        const store = new Map<string, string>();
        g.localStorage = {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => void store.set(k, String(v)),
          removeItem: (k: string) => void store.delete(k),
          clear: () => store.clear(),
        };
        g.sessionStorage = { ...g.localStorage };
      }
      await import('fake-indexeddb/auto');
      const [{ FeedOrchestrator }, { profileTimelineConfig }] = [
        await import('./FeedOrchestrator'),
        await import('../../components/timeline/TimelineConfig'),
      ];
      const orch = FeedOrchestrator.getInstance();

      for (const pubkey of KNOWN_POSTERS) {
        const result = await orch.loadInitialFeed({
          followingPubkeys: [pubkey],
          // Raw pipeline check — reply filtering is orthogonal and could
          // legitimately hide every note of a reply-heavy author.
          includeReplies: true,
          exemptFromMuteFilter: pubkey,
          config: profileTimelineConfig(pubkey),
        });
        expect(
          result.events.length,
          `profile ${pubkey.slice(0, 8)}… returned 0 events — PV fast-empty regression?`
        ).toBeGreaterThan(0);
        // Author-scoped filter: every returned event must be the author's.
        expect(result.events.every(e => e.pubkey === pubkey)).toBe(true);
      }
    }
  );
});
