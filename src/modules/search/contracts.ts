import type { SearchOptions, ProfileSearchResult } from '../../services/orchestration/SearchOrchestrator';
import type { UserSearchResult, UserSearchCallbacks } from '../../services/UserSearchService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type { SearchOptions, ProfileSearchResult, UserSearchResult, UserSearchCallbacks };

export interface SearchModuleApi {
  search(options: SearchOptions): Promise<NostrEvent[]>;
  searchPaginated(options: SearchOptions, until?: number): Promise<NostrEvent[]>;
  searchProfiles(query: string, limit?: number): Promise<ProfileSearchResult[]>;

  // UserSearchService
  searchUsers(query: string, callbacks: UserSearchCallbacks): AbortController;
}
