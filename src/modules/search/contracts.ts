import type { SearchOptions, ProfileSearchResult } from '../../services/orchestration/SearchOrchestrator';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type { SearchOptions, ProfileSearchResult };

export interface SearchModuleApi {
  search(options: SearchOptions): Promise<NostrEvent[]>;
  searchPaginated(options: SearchOptions & { offset?: number; limit?: number }): Promise<NostrEvent[]>;
  searchProfiles(query: string, limit?: number): Promise<ProfileSearchResult[]>;
}
