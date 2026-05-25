import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { FeedLoadRequest, FeedLoadResult } from '../../services/orchestration/FeedOrchestrator';

export type { FeedLoadRequest, FeedLoadResult };

export interface TimelineModuleApi {
  loadInitialFeed(request: FeedLoadRequest): Promise<FeedLoadResult>;
  loadMore(request: FeedLoadRequest & { until: number }): Promise<FeedLoadResult>;
  getLoadedNote(eventId: string): NostrEvent | null;
  hasLoadedNote(eventId: string): boolean;
  registerNotes(events: NostrEvent[]): void;
  clearCache(): void;
}
