import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type {
  FeedLoadRequest,
  FeedLoadResult,
  NewNotesInfo,
} from '../../services/orchestration/FeedOrchestrator';

export type { FeedLoadRequest, FeedLoadResult, NewNotesInfo };

export type NewNotesCallback = (info: NewNotesInfo) => void;

export interface TimelineModuleApi {
  loadInitialFeed(request: FeedLoadRequest): Promise<FeedLoadResult>;
  loadMore(
    request: FeedLoadRequest & { until: number }
  ): Promise<FeedLoadResult>;
  /** "Last notes per follow": the newest qualifying kind-1 note of each author, newest-author-first. */
  loadLatestPerAuthor(
    pubkeys: string[],
    includeReplies: boolean,
    applyWordFilter: boolean
  ): Promise<NostrEvent[]>;
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
    exemptFromMuteFilter?: string,
    applyWordFilter?: boolean
  ): void;
  stopPolling(): void;
  getPolledEvents(): NostrEvent[];
  resetPollingTimestamp(newTimestamp: number): void;
  pollOnce(
    followingPubkeys: string[],
    newestTimestamp: number,
    includeReplies: boolean,
    specificRelay: string | null,
    exemptFromMuteFilter: string | undefined,
    applyWordFilter: boolean
  ): Promise<NostrEvent[]>;

  // Mute management
  refreshMutedUsers(): void;

  // Event metadata
  getEventRelays(eventId: string): string[];
}
