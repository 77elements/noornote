import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { FeedLoadRequest, FeedLoadResult, NewNotesInfo } from '../../services/orchestration/FeedOrchestrator';

export type { FeedLoadRequest, FeedLoadResult, NewNotesInfo };

export type NewNotesCallback = (info: NewNotesInfo) => void;

export interface TimelineModuleApi {
  loadInitialFeed(request: FeedLoadRequest): Promise<FeedLoadResult>;
  loadMore(request: FeedLoadRequest & { until: number }): Promise<FeedLoadResult>;
  getLoadedNote(eventId: string): NostrEvent | null;
  hasLoadedNote(eventId: string): boolean;
  registerNotes(events: NostrEvent[]): void;
  clearCache(): void;

  // Polling
  startPolling(
    followingPubkeys: string[],
    lastLoadedTimestamp: number,
    callback: NewNotesCallback,
    includeReplies?: boolean,
    delayMs?: number,
    specificRelay?: string | null,
    exemptFromMuteFilter?: string
  ): void;
  stopPolling(): void;
  getPolledEvents(): NostrEvent[];
  resetPollingTimestamp(newTimestamp: number): void;
  pollOnce(
    followingPubkeys: string[],
    newestTimestamp: number,
    includeReplies: boolean,
    specificRelay: string | null,
    exemptFromMuteFilter?: string
  ): Promise<NostrEvent[]>;

  // Mute management
  refreshMutedUsers(): Promise<void>;

  // Event metadata
  getEventRelays(eventId: string): string[];
}
