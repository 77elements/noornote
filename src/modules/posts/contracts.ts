import type {
  PostOptions,
  ReplyOptions,
  HighlightOptions,
} from '../../services/PostService';
import type { RepostOptions } from '../../services/RepostService';
import type { DeletionOptions } from '../../services/DeletionService';
import type { BroadcastProgress } from '../../services/BroadcastDeleteService';
import type { ReportType, ReportOptions } from '../../services/ReportService';
import type { MentionSuggestion } from '../../components/mentions/MentionAutocomplete';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type {
  PostOptions,
  ReplyOptions,
  HighlightOptions,
  RepostOptions,
  DeletionOptions,
  BroadcastProgress,
  ReportType,
  ReportOptions,
  MentionSuggestion,
};

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

  /** Cache-only NIP-65 write relays for a pubkey ([] when undiscovered) —
   *  used as relay hints when rendering reposted notes' author profiles. */
  getCachedWriteRelays(pubkey: string): string[];

  // RepostService
  hasUserReposted(noteId: string): Promise<boolean>;
  publishRepost(
    options: RepostOptions
  ): Promise<{ success: boolean; alreadyReposted?: boolean; error?: string }>;
  publishGenericRepost(
    options: RepostOptions
  ): Promise<{ success: boolean; error?: string }>;

  // DeletionService
  deleteEvent(eventId: string, reason?: string): Promise<boolean>;
  deleteEvents(options: DeletionOptions): Promise<boolean>;
  deleteByCoordinates(coordinates: string[], reason?: string): Promise<boolean>;

  // BroadcastDeleteService — live progress of silent (Bulk Delete) broadcasts
  subscribeDeleteProgress(cb: (p: BroadcastProgress) => void): () => void;
  countActiveDeleteBroadcasts(): Promise<number>;
  getDeleteProgressSummary(): Promise<{
    total: number;
    contacted: number;
    sent: number;
  } | null>;

  // ReportService
  createReport(
    options: ReportOptions
  ): Promise<{ success: boolean; error?: string }>;
  getReportTypes(): ReportType[];
  getReportTypeLabel(type: ReportType): string;
  getReportTypeDescription(type: ReportType): string;

  // MentionProfileCache
  getMentionSuggestions(
    followingPubkeys: string[]
  ): Promise<MentionSuggestion[]>;
}
