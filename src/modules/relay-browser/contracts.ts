import type { RelayBrowserResult } from '../../services/orchestration/RelayBrowserOrchestrator';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type { RelayBrowserResult };

export interface RelayBrowserModuleApi {
  setRelay(url: string): void;
  loadInitial(): Promise<RelayBrowserResult>;
  loadMore(): Promise<RelayBrowserResult>;
  pollNewNotes(): Promise<NostrEvent[]>;
}
