import type { PostOptions, ReplyOptions, HighlightOptions } from '../../services/PostService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type { PostOptions, ReplyOptions, HighlightOptions };

export interface PostsModuleApi {
  createPost(options: PostOptions): Promise<boolean>;
  createReply(options: ReplyOptions): Promise<NostrEvent | null>;
  createHighlight(options: HighlightOptions): Promise<boolean>;
}
