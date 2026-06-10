import type { Profile } from '../../services/orchestration/ProfileOrchestrator';
import type { ProfileMetadata } from '../../services/ProfileEditorService';
import type { SearchRequest, SearchResult } from '../../services/orchestration/ProfileSearchOrchestrator';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type { Profile, ProfileMetadata, SearchRequest, SearchResult };

export interface ProfileModuleApi {
  fetchProfile(pubkey: string): Promise<Profile | null>;
  fetchMultipleProfiles(pubkeys: string[]): Promise<Map<string, Profile>>;
  fetchOldestEvent(pubkey: string): Promise<number | null>;

  // ProfileEditorService
  updateProfile(metadata: ProfileMetadata): Promise<NostrEvent | null>;
  validateNip05(nip05: string): boolean;
  validateLightningAddress(address: string): { valid: boolean; field: 'lud16' | 'lud06' };

  // FollowerCountService
  getFollowerCount(pubkey: string, onUpdate?: (count: number, relay: string) => void): Promise<number>;
  streamFollowerList(pubkey: string, onBatch: (newPubkeys: string[]) => void): Promise<string[]>;

  // ProfileMountsService
  getProfileMounts(): string[];
  reorderProfileMounts(newOrder: string[]): void;

  // ProfileMountsOrchestrator
  fetchMountsFromRelays(pubkey: string, forceRefresh?: boolean): Promise<string[]>;
  publishMountsToRelays(): Promise<void>;
  syncMountsFromRelays(): Promise<void>;

  // ProfileSearchOrchestrator
  searchUserNotes(request: SearchRequest): Promise<SearchResult>;
}
