import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const orch = { fetchProfile: mockFetchProfile, fetchMultipleProfiles: mockFetchMultipleProfiles };

const PK = 'aa'.repeat(32);
const PK2 = 'bb'.repeat(32);

import { UserProfileService, type UserProfile } from './UserProfileService';

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
    orch.fetchProfile.mockImplementation(() => new Promise(resolve =>
      setTimeout(() => resolve(realProfile(PK, 'alice')), 20)
    ));
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
    orch.fetchMultipleProfiles.mockResolvedValue(new Map([[PK, realProfile(PK, 'batched')]]));
    orch.fetchProfile.mockResolvedValue(null); // stage-2 recovery finds nothing

    const result = await service.getUserProfiles([PK, PK2]);

    expect(result.get(PK)?.name).toBe('batched');
    expect(result.get(PK2)?.pubkey).toBe(PK2); // placeholder, non-null per contract
    expect(service.hasProfile(PK)).toBe(true); // real hit cached
    expect(service.hasProfile(PK2)).toBe(false); // placeholder NOT cached
  });

  it('getUserProfiles: a name-less aggregator hit is cached but NOT broadcast', async () => {
    orch.fetchMultipleProfiles.mockResolvedValue(new Map([[PK, { pubkey: PK }]]));
    const updates: string[] = [];
    service.subscribeToAnyProfileUpdate((_pk, p) => updates.push(p.name ?? '(none)'));

    await service.getUserProfiles([PK]);

    expect(service.hasProfile(PK)).toBe(true);
    expect(updates).toEqual([]); // no downgrade broadcast for name-less entries
  });
});

describe('UserProfileService (render-ready fallbacks)', () => {
  it('displayNameOf prefers display_name > name > username > npub fallback', () => {
    expect(UserProfileService.displayNameOf({ pubkey: PK, display_name: 'D', name: 'N' }, PK)).toBe('D');
    expect(UserProfileService.displayNameOf({ pubkey: PK, name: 'N' }, PK)).toBe('N');
    expect(UserProfileService.displayNameOf({ pubkey: PK, username: 'U' }, PK)).toBe('U');
    const fallback = UserProfileService.displayNameOf(null, PK);
    expect(fallback).toMatch(/^@[a-z0-9]+…$/);
  });

  it('displayPictureOf falls back to a deterministic identicon data-URL', () => {
    expect(UserProfileService.displayPictureOf({ pubkey: PK, picture: 'https://x/y.png' }, PK))
      .toBe('https://x/y.png');
    const a = UserProfileService.displayPictureOf(null, PK);
    expect(a).toMatch(/^data:image\/svg\+xml/);
    expect(UserProfileService.displayPictureOf(null, PK)).toBe(a); // deterministic
    expect(UserProfileService.displayPictureOf(null, PK2)).not.toBe(a); // per-pubkey
  });
});
