/**
 * Shared types for Note Processing & Rendering
 * Single source of truth for note-related interfaces
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { PollData } from '../../poll/PollCreator';

export interface ProcessedNote {
  id: string;
  type:
    | 'original'
    | 'repost'
    | 'quote'
    | 'poll'
    | 'zap-receipt'
    | 'unsupported'
    | 'follow-pack'
    | 'curation-set'
    | 'bookmark-list'
    | 'reaction'
    | 'podcast-episode'
    | 'git-event'
    | 'highlight'
    | 'badge-award'
    | 'badge-definition'
    | 'community-definition'
    | 'emoji-pack'
    | 'live-stream'
    | 'listing'
    | 'nsite'
    | 'calendar-event'
    | 'calendar-collection'
    | 'music-track'
    | 'music-playlist'
    | 'sno-object'
    | 'premium';
  timestamp: number;
  author: {
    pubkey: string;
    profile?: {
      name?: string;
      display_name?: string;
      picture?: string;
    };
  };
  reposter?: {
    pubkey: string;
    profile?: {
      name?: string;
      display_name?: string;
      picture?: string;
    };
  };
  content: {
    text: string;
    html: string;
    media: MediaContent[];
    links: LinkPreview[];
    hashtags: string[];
    quotedReferences: QuotedReference[];
    bolt11Invoices: import('../../../helpers/extractBolt11').Bolt11Match[];
  };
  rawEvent: NostrEvent;
  quotedEvent?: ProcessedNote;
  repostedEvent?: NostrEvent;
  pollData?: PollData;
  zapReceiptData?: ZapReceiptData;
  badgeData?: {
    coordinate: string;
    slug: string;
    /** kind 8 only: awardee pubkeys. */
    awardees?: string[];
    /** kind 30009 only: self-contained definition data (from tags). */
    name?: string;
    description?: string;
    image?: string;
    thumb?: string;
  };
  /** kind 33331 only: parsed SNO geometry (DECK-0003) + name/alt tags. */
  snoData?: import('../note-processing/SnoProcessor').SnoData;
  /** kind 36787 only: parsed music track metadata. */
  musicTrack?: import('../../../helpers/parseMusicTrack').MusicTrackData;
  /** kind 34139 only: parsed playlist header + track references. */
  musicPlaylist?: import('../../../helpers/parseMusicTrack').MusicPlaylistData;
}

export interface ZapReceiptData {
  amountSats: number;
  senderPubkey?: string;
  recipientPubkey: string;
  message?: string;
  targetEventId?: string;
}

export interface MediaContent {
  type: 'image' | 'video' | 'audio' | 'epub';
  url: string;
  originalUrl?: string;
  alt?: string;
  thumbnail?: string;
  dimensions?: { width: number; height: number };
  taggedPubkeys?: string[];
  /** EPUB only: SHA-256 of the file (NIP-92 imeta `x`) — stable key for reading progress */
  hash?: string;
  /**
   * BUD-10 only: parsed `blossom:` URI the media was extracted from. `url`
   * holds the raw URI (not fetchable by <img>/<video>); rendering goes through
   * the async BlossomResolver (see renderMediaContent's .blossom-media mount).
   */
  blossom?: import('../../../helpers/blossomUri').BlossomUriInfo;
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  domain: string;
}

export interface QuotedReference {
  type: 'event' | 'note' | 'addr';
  id: string;
  fullMatch: string;
  quotedNote?: ProcessedNote;
  /** Armada invite unlock fragment (without leading `#`). See ContentProcessor.QuotedReference. */
  fragment?: string;
}

export interface NoteUIOptions {
  collapsible?: boolean;
  islFetchStats?: boolean;
  isLoggedIn?: boolean;
  headerSize?: 'small' | 'medium' | 'large';
  depth?: number;
  replyContext?: boolean; // SNV reply thread: render the thread-context band with a leading ↳
  zapReceiptClickable?: boolean; // Zap-receipt cards navigate to the zapped note on click (default true); disable for inert previews
}
