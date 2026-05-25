import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ThreadContext } from '../../services/orchestration/ThreadOrchestrator';

export type { ThreadContext };

export interface SingleNoteModuleApi {
  fetchReplies(noteId: string): Promise<NostrEvent[]>;
  fetchParentChain(noteId: string): Promise<ThreadContext>;
  startLiveReplies(noteId: string, callback: (event: NostrEvent) => void): void;
  stopLiveReplies(noteId: string): void;
  clearCache(noteId: string): void;
}
