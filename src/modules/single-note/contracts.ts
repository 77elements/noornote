import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ThreadContext } from '../../services/orchestration/ThreadOrchestrator';
import type { VoteOptions } from '../../services/PollVoteService';
import type { PollResults } from '../../services/orchestration/PollOrchestrator';

export type { ThreadContext, VoteOptions };

interface ParentAuthorInfo {
  displayName: string;
  avatarUrl: string;
  pubkey: string;
}

export type { ParentAuthorInfo };

interface PollOptionInput {
  id: string;
  label: string;
}

export type { PollOptionInput };

export interface SingleNoteModuleApi {
  /** Cache-only lookup (NoteService LRU). Returns a note already loaded by a feed without any relay fetch. */
  getCachedNote(noteId: string): NostrEvent | null;
  /** Push a fully-loaded event into the note cache so a subsequent SNV open resolves it without a relay fetch. */
  cacheNote(event: NostrEvent): void;
  fetchReplies(noteId: string, authorPubkey?: string): Promise<NostrEvent[]>;
  fetchParentChain(noteId: string): Promise<ThreadContext>;
  startLiveReplies(noteId: string, callback: (event: NostrEvent) => void): void;
  stopLiveReplies(noteId: string): void;
  clearCache(noteId: string): void;

  // ParentNoteFetcher
  fetchParentAuthor(
    parentEventId: string,
    relayHint: string | null
  ): Promise<ParentAuthorInfo | null>;

  // PollVoteService
  castVote(options: VoteOptions): Promise<boolean>;

  // QuoteOrchestrator
  fetchQuotedEvent(
    nostrRef: string,
    authorHint?: string,
    extraOutboundPubkeys?: string[]
  ): Promise<NostrEvent | null>;

  // PollOrchestrator
  fetchPollResults(
    pollEventId: string,
    pollOptions: PollOptionInput[],
    currentUserPubkey?: string
  ): Promise<PollResults>;
  clearPollCache(pollEventId: string): void;
}
