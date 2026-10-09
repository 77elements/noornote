/**
 * Shared vi.mock factories for the list tests (src/lists/*.test.ts).
 *
 * Test-only: this module is imported exclusively from *.test.ts files, never
 * by app code, so it never enters the production bundle.
 *
 * vi.mock factories are hoisted above the test file's imports, so helpers
 * must be loaded via dynamic import inside the factory (vitest-sanctioned
 * pattern):
 *
 *   vi.mock('./relays', async () => {
 *     const { makeInertRelayMock } = await import('./syncRelayTestMock');
 *     return makeInertRelayMock(TEST_PK);
 *   });
 */

export interface SyncRelayFixture {
  published: Array<{ kind: number; tags: string[][]; content: string }>;
  writeRelays: string[];
}

export interface SyncCryptoStore {
  plaintexts: Map<string, string>;
}

/**
 * Tail of the `./relays` mock shared by the sync tests (bookmarks, tribes,
 * mutes): publish/sign/encrypt round-trip wired to the file-local fixtures.
 * fetchEvents stays per-file — the bucket routing differs per list.
 */
export function makeSyncRelayMockTail(
  relay: SyncRelayFixture,
  cryptoStore: SyncCryptoStore
) {
  return {
    publishEvent: async (event: {
      kind: number;
      tags: string[][];
      content: string;
    }) => {
      relay.published.push(event);
      return new Set(['wss://relay']);
    },
    signEvent: async (event: {
      kind: number;
      tags: string[][];
      content: string;
    }) => ({
      ...event,
      id: 'de'.repeat(32),
      sig: 'ff'.repeat(64),
    }),
    encryptContent: async (plaintext: string) => {
      const ct = `enc:${plaintext}`;
      cryptoStore.plaintexts.set(ct, plaintext);
      return ct;
    },
    decryptContent: async (ciphertext: string) =>
      cryptoStore.plaintexts.get(ciphertext) ?? null,
  };
}

/** Inert `./relays` mock for CRUD tests that never touch the relay. */
export function makeInertRelayMock(testPk: string) {
  return {
    getTransport: () => ({}),
    getReadRelays: () => [],
    getWriteRelays: () => [],
    getCurrentUserPubkey: () => testPk,
    requireAuth: () => ({ pubkey: testPk }),
    fetchEvents: async () => [],
    publishEvent: async () => new Set<string>(),
    signEvent: async () => null,
    encryptContent: async () => '',
    decryptContent: async () => '',
  };
}

/** Canonical `../services/AuthService` mock: always signed in as testPk. */
export function makeAuthServiceMock(testPk: string) {
  return {
    AuthService: {
      getInstance: () => ({ getCurrentUser: () => ({ pubkey: testPk }) }),
    },
  };
}
