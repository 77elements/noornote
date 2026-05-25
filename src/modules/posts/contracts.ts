import type { PostOptions, ReplyOptions, HighlightOptions } from '../../services/PostService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type { PostOptions, ReplyOptions, HighlightOptions };

export interface PostsModuleApi {
  createPost(options: PostOptions): Promise<boolean>;
  createReply(options: ReplyOptions): Promise<NostrEvent | null>;
  createHighlight(options: HighlightOptions): Promise<boolean>;

  // NoteService (note cache)
  getNote(eventId: string): Promise<NostrEvent | null>;
  getNotes(eventIds: string[]): Promise<Map<string, NostrEvent>>;
  getCachedNote(eventId: string): NostrEvent | null;
  registerNote(event: NostrEvent): void;
  registerNotes(events: NostrEvent[]): void;
  hasNote(eventId: string): boolean;
}
