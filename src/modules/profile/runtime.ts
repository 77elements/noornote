import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ProfileModuleApi } from './contracts';

export class ProfileRuntime implements ModuleRuntime<ProfileModuleApi> {
  private orchestrator:
    | import('../../services/orchestration/ProfileOrchestrator').ProfileOrchestrator
    | null = null;
  private editorService:
    | import('../../services/ProfileEditorService').ProfileEditorService
    | null = null;
  private followerCountService:
    | import('../../services/FollowerCountService').FollowerCountService
    | null = null;
  private mountsService:
    | import('../../services/ProfileMountsService').ProfileMountsService
    | null = null;
  private mountsOrchestrator:
    | import('../../services/orchestration/ProfileMountsOrchestrator').ProfileMountsOrchestrator
    | null = null;
  private searchOrchestrator:
    | import('../../services/orchestration/ProfileSearchOrchestrator').ProfileSearchOrchestrator
    | null = null;
  private carouselOrchestrator:
    | import('../../services/orchestration/ProfileCarouselOrchestrator').ProfileCarouselOrchestrator
    | null = null;
  private transport:
    | import('../../services/transport/NostrTransport').NostrTransport
    | null = null;
  private badgeOrchestrator:
    | import('../../services/orchestration/BadgeOrchestrator').BadgeOrchestrator
    | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [
      orchMod,
      editorMod,
      followerMod,
      mountsMod,
      mountsOrchMod,
      searchMod,
      carouselMod,
      transportMod,
      badgeMod,
    ] = await Promise.all([
      import('../../services/orchestration/ProfileOrchestrator'),
      import('../../services/ProfileEditorService'),
      import('../../services/FollowerCountService'),
      import('../../services/ProfileMountsService'),
      import('../../services/orchestration/ProfileMountsOrchestrator'),
      import('../../services/orchestration/ProfileSearchOrchestrator'),
      import('../../services/orchestration/ProfileCarouselOrchestrator'),
      import('../../services/transport/NostrTransport'),
      import('../../services/orchestration/BadgeOrchestrator'),
    ]);
    this.orchestrator = orchMod.ProfileOrchestrator.getInstance();
    this.editorService = editorMod.ProfileEditorService.getInstance();
    this.followerCountService = followerMod.FollowerCountService.getInstance();
    this.mountsService = mountsMod.ProfileMountsService.getInstance();
    this.mountsOrchestrator =
      mountsOrchMod.ProfileMountsOrchestrator.getInstance();
    this.searchOrchestrator = searchMod.ProfileSearchOrchestrator.getInstance();
    this.carouselOrchestrator =
      carouselMod.ProfileCarouselOrchestrator.getInstance();
    this.transport = transportMod.NostrTransport.getInstance();
    this.badgeOrchestrator = badgeMod.BadgeOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
    this.editorService = null;
    this.followerCountService = null;
    this.mountsService = null;
    this.mountsOrchestrator = null;
    this.searchOrchestrator = null;
    this.carouselOrchestrator = null;
    this.transport = null;
    this.badgeOrchestrator = null;
  }

  getApi(): ProfileModuleApi {
    const orch = this.orchestrator;
    const es = this.editorService;
    const fc = this.followerCountService;
    const ms = this.mountsService;
    const mo = this.mountsOrchestrator;
    const so = this.searchOrchestrator;
    const co = this.carouselOrchestrator;
    const tp = this.transport;
    const bo = this.badgeOrchestrator;
    return {
      fetchProfile: pubkey =>
        orch?.fetchProfile(pubkey) ?? Promise.resolve(null),
      fetchMultipleProfiles: pubkeys =>
        orch?.fetchMultipleProfiles(pubkeys) ?? Promise.resolve(new Map()),
      fetchOldestEvent: pubkey =>
        orch?.fetchOldestEvent(pubkey) ?? Promise.resolve(null),
      updateProfile: metadata =>
        es?.updateProfile(metadata) ?? Promise.resolve(null),
      validateNip05: nip05 => es?.validateNip05(nip05) ?? false,
      validateLightningAddress: address =>
        es?.validateLightningAddress(address) ?? {
          valid: false,
          field: 'lud16',
        },
      getFollowerCount: (pubkey, onUpdate) =>
        fc?.getFollowerCount(pubkey, onUpdate) ?? Promise.resolve(0),
      streamFollowerList: (pubkey, onBatch, opts) =>
        fc?.streamFollowerList(pubkey, onBatch, opts) ?? Promise.resolve([]),
      getProfileMounts: () => ms?.getMounts() ?? [],
      reorderProfileMounts: newOrder => ms?.reorderMounts(newOrder),
      fetchMountsFromRelays: (pubkey, forceRefresh) =>
        mo?.fetchFromRelays(pubkey, forceRefresh) ?? Promise.resolve([]),
      publishMountsToRelays: () => mo?.publishToRelays() ?? Promise.resolve(),
      syncMountsFromRelays: () => mo?.syncFromRelays() ?? Promise.resolve(),
      searchUserNotes: request =>
        so?.searchUserNotes(request) ??
        Promise.resolve({
          events: [],
          matchCount: 0,
          totalNotes: 0,
          dateRange: { start: 'N/A', end: 'N/A' },
        }),
      fetchCarouselContent: pubkey =>
        co?.fetchProfileContent(pubkey) ??
        Promise.resolve({
          articles: [],
          videos: [],
          listings: [],
          deletions: [],
          hintRelays: [],
        }),
      invalidateCarouselCacheForCurrentUser: () =>
        co?.invalidateForCurrentUser(),
      fetchAddressableEvents: async (addresses, timeoutMs) => {
        if (!tp || addresses.length === 0) return [];
        const readRelays = tp.getReadRelays();
        if (readRelays.length === 0) return [];
        const filters = addresses.map(addr => {
          const parts = addr.split(':');
          return {
            kinds: [parseInt(parts[0]!)],
            authors: [parts[1]!],
            '#d': [parts.slice(2).join(':')],
          };
        });
        try {
          return await tp.fetch(
            readRelays,
            filters,
            timeoutMs ?? 5000,
            false,
            'PLC-Listings'
          );
        } catch {
          return [];
        }
      },
      fetchProfileBadgeEvents: pubkey =>
        bo?.fetchProfileBadgeEvents(pubkey) ?? Promise.resolve([]),
      fetchBadgeDefinition: coordinate =>
        bo?.fetchBadgeDefinition(coordinate) ?? Promise.resolve(null),
      fetchBadgeDefinitions: coordinates =>
        bo?.fetchBadgeDefinitions(coordinates) ?? Promise.resolve(new Map()),
    };
  }
}

export default new ProfileRuntime();
