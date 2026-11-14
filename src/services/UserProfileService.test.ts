import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFetchProfile, mockFetchMultipleProfiles } = vi.hoisted(() => ({
  mockFetchProfile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockFetchMultipleProfiles: vi.fn(),
}));

vi.mock('./orchestration/ProfileOrchestrator', () => {
  const instance = {
    // UserProfileService consumes the *WithMeta shape; route it through the
    // same mock so existing fetchProfile-based tests keep their semantics.
    fetchProfile: mockFetchProfile,
    fetchProfileWithMeta: (...args: unknown[]) =>
      mockFetchProfile(...args).then((profile: unknown) =>
        profile !== null && typeof profile === 'object' && 'timedOut' in profile
          ? (profile as { profile: unknown; timedOut: boolean })
          : { profile, timedOut: false }
      ),
    fetchMultipleProfiles: mockFetchMultipleProfiles,
  };
  return {
    ProfileOrchestrator: {
      getInstance: () => instance,
    },
  };
});

vi.mock('./ProfileStore', () => ({
  profileStore: {
    saveMany: vi.fn(),
    loadAll: vi.fn(async () => new Map()),
    get: vi.fn(async () => null),
    delete: vi.fn(),
    wipePersisted: vi.fn(),
  },
}));

vi.mock('./AuthService', () => ({
  AuthService: {
    getInstance: () => ({
      getCurrentUser: () => ({ npub: 'npub1test', pubkey: 'pk' }),
    }),
  },
}));

// EventBus pulls in SystemLogger (DOM-dependent) — mock it and capture the
// 'relay:connected' handler in a plain array (survives vi.clearAllMocks(),
// which would wipe mock.calls history across describes).
const { mockEventEmit, relayHandlers } = vi.hoisted(() => ({
  mockEventEmit: vi.fn(),
  relayHandlers: [] as Array<(data?: unknown) => void>,
}));

vi.mock('./EventBus', () => ({
  EventBus: {
    getInstance: () => ({
      on: (event: string, cb: (data?: unknown) => void) => {
        if (event === 'relay:connected') relayHandlers.push(cb);
        return 'sub-1';
      },
      off: vi.fn(),
      emit: mockEventEmit,
      once: vi.fn(() => 'sub-1'),
    }),
  },
}));

const orch = {
  fetchProfile: mockFetchProfile,
  fetchMultipleProfiles: mockFetchMultipleProfiles,
};

const PK = 'aa'.repeat(32);
const PK2 = 'bb'.repeat(32);

import { UserProfileService, type UserProfile } from './UserProfileService';
import { profileStore } from './ProfileStore';

const store = profileStore as unknown as {
  saveMany: ReturnType<typeof vi.fn>;
  loadAll: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  wipePersisted: vi.Mock;
};

const realProfile = (pubkey: string, name: string): UserProfile => ({
  pubkey,
  name,
  picture: `https://img/${name}.png`,
});

describe('UserProfileService (cache semantics)', () => {
  let service: UserProfileService;

  beforeEach(() => {
    orch.fetchProfile.mockReset();
    orch.fetchMultipleProfiles.mockReset();
    store.get.mockReset().mockResolvedValue(null);
    // fresh singleton per test — UserProfileService.instance is private,
    // so reset through clearCache + a new reference is not possible; instead
    // reuse one instance and clear all mutable state.
    service = UserProfileService.getInstance();
    service.clearCache();
  });

  it('caches a fetched profile — second call must not re-fetch', async () => {
    orch.fetchProfile.mockResolvedValue(realProfile(PK, 'alice'));
    await service.getUserProfile(PK);
    await service.getUserProfile(PK);
    expect(orch.fetchProfile).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent fetches for the same pubkey (in-flight join)', async () => {
    orch.fetchProfile.mockImplementation(
      () =>
        new Promise(resolve =>
          setTimeout(() => resolve(realProfile(PK, 'alice')), 20)
        )
    );
    const [a, b] = await Promise.all([
      service.getUserProfile(PK),
      service.getUserProfile(PK),
    ]);
    expect(orch.fetchProfile).toHaveBeenCalledTimes(1);
    expect(a.name).toBe('alice');
    expect(b.name).toBe('alice');
  });

  it('a relay miss is NOT cached and enters the retry cooldown', async () => {
    orch.fetchProfile.mockResolvedValue(null);
    const first = await service.getUserProfile(PK);
    expect(first.pubkey).toBe(PK);
    expect(first.name).toBeUndefined(); // default placeholder, no fabricated data

    // second call within cooldown must not hit relays again
    const second = await service.getUserProfile(PK);
    expect(orch.fetchProfile).toHaveBeenCalledTimes(1);
    expect(second.pubkey).toBe(PK);
  });

  it('caller-provided relay hints bypass the cooldown (untried source)', async () => {
    orch.fetchProfile.mockResolvedValue(null);
    await service.getUserProfile(PK); // seeds the cooldown

    orch.fetchProfile.mockResolvedValue(realProfile(PK, 'late'));
    const viaHint = await service.getUserProfile(PK, ['wss://hint.relay']);
    expect(viaHint.name).toBe('late');
    expect(orch.fetchProfile).toHaveBeenCalledTimes(2);
  });

  it('a successful fetch clears a prior failure record', async () => {
    orch.fetchProfile.mockResolvedValueOnce(null);
    await service.getUserProfile(PK);
    orch.fetchProfile.mockResolvedValueOnce(realProfile(PK, 'back'));
    await service.getUserProfile(PK, ['wss://any.relay']); // hint bypasses cooldown
    // cooldown must be gone: next miss-free call fetches only if uncached —
    // but 'back' IS cached now, so no fetch. Prove cooldown cleared by cache hit:
    expect(service.hasProfile(PK)).toBe(true);
    expect(orch.fetchProfile).toHaveBeenCalledTimes(2);
  });

  it('subscribeToProfile fires immediately with cached data and on updates', async () => {
    orch.fetchProfile.mockResolvedValue(realProfile(PK, 'alice'));
    const seen: string[] = [];
    const unsub = service.subscribeToProfile(PK, p => seen.push(p.name ?? '?'));
    // First delivery arrives twice (once via notifyProfileUpdate, once via the
    // direct promise chain) — documented current behavior, idempotent payload.
    await vi.waitFor(() => expect(seen).toEqual(['alice', 'alice']));

    service.setCachedProfile(PK, realProfile(PK, 'alice2'));
    expect(seen).toEqual(['alice', 'alice', 'alice2']);

    unsub();
    service.setCachedProfile(PK, realProfile(PK, 'alice3'));
    expect(seen).toEqual(['alice', 'alice', 'alice2']); // no callback after unsubscribe
  });

  it('getUserProfiles: batch hit via aggregator, misses beyond recovery stay uncached placeholders', async () => {
    orch.fetchMultipleProfiles.mockResolvedValue(
      new Map([[PK, realProfile(PK, 'batched')]])
    );
    orch.fetchProfile.mockResolvedValue(null); // stage-2 recovery finds nothing

    const result = await service.getUserProfiles([PK, PK2]);

    expect(result.get(PK)?.name).toBe('batched');
    expect(result.get(PK2)?.pubkey).toBe(PK2); // placeholder, non-null per contract
    expect(service.hasProfile(PK)).toBe(true); // real hit cached
    expect(service.hasProfile(PK2)).toBe(false); // placeholder NOT cached
  });

  it('getUserProfiles: a name-less aggregator hit is cached but NOT broadcast', async () => {
    orch.fetchMultipleProfiles.mockResolvedValue(
      new Map([[PK, { pubkey: PK }]])
    );
    const updates: string[] = [];
    service.subscribeToAnyProfileUpdate((_pk, p) =>
      updates.push(p.name ?? '(none)')
    );

    await service.getUserProfiles([PK]);

    expect(service.hasProfile(PK)).toBe(true);
    expect(updates).toEqual([]); // no downgrade broadcast for name-less entries
  });
});

describe('UserProfileService (ProfileStore integration)', () => {
  let service: UserProfileService;

  beforeEach(() => {
    vi.clearAllMocks();
    orch.fetchProfile.mockReset();
    orch.fetchMultipleProfiles.mockReset();
    store.loadAll.mockReset().mockResolvedValue(new Map());
    store.get.mockReset().mockResolvedValue(null);
    service = UserProfileService.getInstance();
    service.clearCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('display-bearing fetch results are persisted (debounced batch)', async () => {
    orch.fetchProfile.mockResolvedValue(realProfile(PK, 'alice'));
    await service.getUserProfile(PK);

    expect(store.saveMany).not.toHaveBeenCalled(); // still inside debounce window
    vi.advanceTimersByTime(2000);
    expect(store.saveMany).toHaveBeenCalledTimes(1);
    const batch = store.saveMany.mock.calls[0][0] as Map<string, UserProfile>;
    expect(batch.get(PK)?.name).toBe('alice');
  });

  it('name-less fetch results are NEVER persisted', async () => {
    orch.fetchProfile.mockResolvedValue({ pubkey: PK });
    await service.getUserProfile(PK);
    vi.advanceTimersByTime(2000);
    expect(store.saveMany).not.toHaveBeenCalled();
  });

  it('warmFromStore fills the LRU and notifies for display-bearing entries', async () => {
    const updates: string[] = [];
    // any-updates subscriber (fetch-free registration — per-pubkey subscribe
    // would trigger a relay fetch on cache miss, which warm must not need)
    const unsub = service.subscribeToAnyProfileUpdate((_pk, p) =>
      updates.push(p.name ?? '(none)')
    );
    store.loadAll.mockResolvedValue(
      new Map([[PK, realProfile(PK, 'restored')]])
    );

    await service.warmFromStore();

    expect(service.hasProfile(PK)).toBe(true);
    expect(orch.fetchProfile).not.toHaveBeenCalled(); // warm, not fetch
    expect(updates).toEqual(['restored']);
    unsub();
  });

  it('warmFromStore never overwrites fresher in-memory entries', async () => {
    service.setCachedProfile(PK, realProfile(PK, 'fresh'));
    store.loadAll.mockResolvedValue(new Map([[PK, realProfile(PK, 'stale')]]));

    await service.warmFromStore();

    expect(service.getCachedProfile(PK)?.name).toBe('fresh');
  });

  it('warmFromStore is idempotent per account', async () => {
    await service.warmFromStore();
    await service.warmFromStore();
    expect(store.loadAll).toHaveBeenCalledTimes(1);
  });

  it('clearCache drops the warm guard so the next account re-warms', async () => {
    await service.warmFromStore();
    service.clearCache();
    await service.warmFromStore();
    expect(store.loadAll).toHaveBeenCalledTimes(2);
  });

  it('invalidateProfile drops memory AND the persisted entry', async () => {
    service.setCachedProfile(PK, realProfile(PK, 'old'));
    vi.advanceTimersByTime(2000);
    expect(store.saveMany).toHaveBeenCalled();

    service.invalidateProfile(PK);
    expect(service.hasProfile(PK)).toBe(false);
    expect(store.delete).toHaveBeenCalledWith(PK);
  });

  it('clearCache (account switch) flushes pending writes but NEVER wipes the store', async () => {
    service.setCachedProfile(PK, realProfile(PK, 'x'));
    service.clearCache();
    vi.advanceTimersByTime(5000);
    expect(store.wipePersisted).not.toHaveBeenCalled();
  });

  it('wipePersisted (Settings clear-cache) clears memory + store', async () => {
    service.setCachedProfile(PK, realProfile(PK, 'x'));
    await service.wipePersisted();
    expect(service.hasProfile(PK)).toBe(false);
    expect(store.wipePersisted).toHaveBeenCalledTimes(1);
  });
});

describe('UserProfileService (render-ready fallbacks)', () => {
  it('displayNameOf prefers display_name > name > username > npub fallback', () => {
    expect(
      UserProfileService.displayNameOf(
        { pubkey: PK, display_name: 'D', name: 'N' },
        PK
      )
    ).toBe('D');
    expect(
      UserProfileService.displayNameOf({ pubkey: PK, name: 'N' }, PK)
    ).toBe('N');
    expect(
      UserProfileService.displayNameOf({ pubkey: PK, username: 'U' }, PK)
    ).toBe('U');
    const fallback = UserProfileService.displayNameOf(null, PK);
    expect(fallback).toMatch(/^@[a-z0-9]+…$/);
  });

  it('displayPictureOf falls back to a deterministic identicon data-URL', () => {
    expect(
      UserProfileService.displayPictureOf(
        { pubkey: PK, picture: 'https://x/y.png' },
        PK
      )
    ).toBe('https://x/y.png');
    const a = UserProfileService.displayPictureOf(null, PK);
    expect(a).toMatch(/^data:image\/svg\+xml/);
    expect(UserProfileService.displayPictureOf(null, PK)).toBe(a); // deterministic
    expect(UserProfileService.displayPictureOf(null, PK2)).not.toBe(a); // per-pubkey
  });
});

describe('UserProfileService (self-healing resolve retries)', () => {
  let service: UserProfileService;

  beforeEach(() => {
    // targeted resets — vi.clearAllMocks() would also wipe the captured
    // EventBus 'relay:connected' handler registration from the constructor.
    orch.fetchProfile.mockReset();
    orch.fetchMultipleProfiles.mockReset();
    store.get.mockReset().mockResolvedValue(null);
    service = UserProfileService.getInstance();
    service.clearCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a TIMEOUT miss gets a short cooldown, a clean miss the full one', async () => {
    // timeout miss → 8s window
    orch.fetchProfile.mockResolvedValueOnce({ profile: null, timedOut: true });
    await service.getUserProfile(PK);
    await vi.advanceTimersByTimeAsync(5000);
    orch.fetchProfile.mockClear();
    orch.fetchProfile.mockResolvedValueOnce(realProfile(PK, 'late'));
    await service.getUserProfile(PK); // still inside the 8s window → no fetch
    expect(orch.fetchProfile).not.toHaveBeenCalled();

    // past the window the fetch runs again
    await vi.advanceTimersByTimeAsync(4000);
    const late = await service.getUserProfile(PK);
    expect(orch.fetchProfile).toHaveBeenCalledTimes(1);
    expect(late.name).toBe('late');

    // clean miss → 30s window
    service.clearCache();
    orch.fetchProfile.mockReset().mockResolvedValueOnce(null);
    await service.getUserProfile(PK2);
    orch.fetchProfile.mockClear();
    await vi.advanceTimersByTimeAsync(9000);
    await service.getUserProfile(PK2);
    expect(orch.fetchProfile).not.toHaveBeenCalled(); // still cooling down
    await vi.advanceTimersByTimeAsync(22000); // 31s total → window over
    orch.fetchProfile.mockResolvedValueOnce(realProfile(PK2, 'late2'));
    await service.getUserProfile(PK2);
    expect(orch.fetchProfile).toHaveBeenCalledTimes(1);
  });

  it('a subscribed-but-unresolved pubkey retries and patches subscribers', async () => {
    orch.fetchProfile
      .mockResolvedValueOnce(null) // initial fetch: miss
      .mockResolvedValueOnce(null) // retry 1: still miss
      .mockResolvedValueOnce(realProfile(PK, 'late')); // retry 2: resolves

    const seen: string[] = [];
    const unsub = service.subscribeToProfile(PK, p => seen.push(p.name ?? '?'));

    // retry fires after the 30s cooldown (+1s safety)
    await vi.advanceTimersByTimeAsync(31000);
    await vi.advanceTimersByTimeAsync(31000);

    expect(seen).toContain('late');
    unsub();
  });

  it('retry attempts are bounded (no endless relay hammering)', async () => {
    orch.fetchProfile.mockResolvedValue(null); // always miss
    const unsub = service.subscribeToProfile(PK, () => {});

    // 1 initial + MAX_RESOLVE_ATTEMPTS retries, then silence
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(31000);
    }
    expect(orch.fetchProfile).toHaveBeenCalledTimes(4);
    unsub();
  });

  it('relay:connected pre-empts the retry timer and re-fetches immediately', async () => {
    orch.fetchProfile.mockResolvedValueOnce({ profile: null, timedOut: true });
    const unsub = service.subscribeToProfile(PK, () => {}); // cold-start timeout miss

    // Fire the captured 'relay:connected' handler (EventBus is mocked).
    expect(relayHandlers.length).toBeGreaterThan(0);
    relayHandlers[relayHandlers.length - 1]();
    await vi.advanceTimersByTimeAsync(2000); // sweep debounce

    expect(orch.fetchProfile).toHaveBeenCalledTimes(2); // sweep re-fetched
    unsub();
  });

  it('unsubscribing cancels the pending retry', async () => {
    // dedicated pubkey — PK may carry subscribers leaked from other tests,
    // and a remaining subscriber legitimately keeps the retry loop alive.
    const PK3 = 'cc'.repeat(32);
    orch.fetchProfile.mockResolvedValue(null);
    const unsub = service.subscribeToProfile(PK3, () => {});
    await vi.advanceTimersByTimeAsync(100); // let the initial fetch settle
    unsub();

    await vi.advanceTimersByTimeAsync(60000);
    expect(orch.fetchProfile).toHaveBeenCalledTimes(1); // no retry after unsub
  });
});
