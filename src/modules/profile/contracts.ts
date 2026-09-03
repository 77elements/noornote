import type { Profile } from '../../services/orchestration/ProfileOrchestrator';
import type { ProfileMetadata } from '../../services/ProfileEditorService';
import type { ProfileCarouselContent } from '../../services/orchestration/ProfileCarouselOrchestrator';
import type { BadgeDefinition } from '../../services/orchestration/BadgeOrchestrator';
import type {
  SearchRequest,
  SearchResult,
} from '../../services/orchestration/ProfileSearchOrchestrator';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type {
  Profile,
  ProfileMetadata,
  ProfileCarouselContent,
  SearchRequest,
  SearchResult,
};

export interface ProfileModuleApi {
  fetchProfile(pubkey: string): Promise<Profile | null>;
  fetchMultipleProfiles(pubkeys: string[]): Promise<Map<string, Profile>>;
  fetchOldestEvent(pubkey: string): Promise<number | null>;

  // ProfileEditorService
  updateProfile(metadata: ProfileMetadata): Promise<NostrEvent | null>;
  validateNip05(nip05: string): boolean;
  validateLightningAddress(address: string): {
    valid: boolean;
    field: 'lud16' | 'lud06';
  };

  // FollowerCountService
  getFollowerCount(
    pubkey: string,
    onUpdate?: (count: number, relay: string) => void
  ): Promise<number>;
  streamFollowerList(
    pubkey: string,
    onBatch: (newPubkeys: string[]) => void,
    opts?: { since?: number; forceFullRelays?: boolean }
  ): Promise<string[]>;

  // ProfileMountsService
  getProfileMounts(): string[];
  reorderProfileMounts(newOrder: string[]): void;

  // ProfileMountsOrchestrator
  fetchMountsFromRelays(
    pubkey: string,
    forceRefresh?: boolean
  ): Promise<string[]>;
  publishMountsToRelays(): Promise<void>;
  syncMountsFromRelays(): Promise<void>;

  // ProfileSearchOrchestrator
  searchUserNotes(request: SearchRequest): Promise<SearchResult>;

  // ProfileCarouselOrchestrator — showcase carousels (articles/videos/listings)
  fetchCarouselContent(pubkey: string): Promise<ProfileCarouselContent>;
  /** Drop the current user's carousel cache (call after publishing content). */
  invalidateCarouselCacheForCurrentUser(): void;

  /** Fetch addressable events by `kind:pubkey:d` coordinates (e.g. mounted
   *  30402 listings on the profile). Returns whatever resolves; never throws. */
  fetchAddressableEvents(
    addresses: string[],
    timeoutMs?: number
  ): Promise<NostrEvent[]>;

  // BadgeOrchestrator — NIP-58
  /** Fetch a profile's badge acceptance events (kind 10008 + legacy 30008). */
  fetchProfileBadgeEvents(pubkey: string): Promise<NostrEvent[]>;
  /** Fetch a single badge definition by its `30009:<issuer>:<slug>` coordinate. */
  fetchBadgeDefinition(coordinate: string): Promise<BadgeDefinition | null>;
  /** Batch-fetch badge definitions by `30009:<issuer>:<slug>` coordinates. */
  fetchBadgeDefinitions(
    coordinates: string[]
  ): Promise<Map<string, BadgeDefinition>>;
}
