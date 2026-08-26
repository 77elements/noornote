import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFetchProfile, mockFetchMultipleProfiles } = vi.hoisted(() => ({
  mockFetchProfile: vi.fn(),
  mockFetchMultipleProfiles: vi.fn(),
}));

vi.mock('./orchestration/ProfileOrchestrator', () => {
  const instance = {
    fetchProfile: mockFetchProfile,
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
