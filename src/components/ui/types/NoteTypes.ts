/**
 * Shared types for Note Processing & Rendering
 * Single source of truth for note-related interfaces
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { PollData } from '../../poll/PollCreator';

export interface ProcessedNote {
  id: string;
  type: 'original' | 'repost' | 'quote' | 'poll' | 'zap-receipt' | 'unsupported';
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
  };
  rawEvent: NostrEvent;
  quotedEvent?: ProcessedNote;
  repostedEvent?: NostrEvent;
  pollData?: PollData;
  zapReceiptData?: ZapReceiptData;
}

export interface ZapReceiptData {
  amountSats: number;
  senderPubkey?: string;
  recipientPubkey: string;
  message?: string;
  targetEventId?: string;
}

export interface MediaContent {
  type: 'image' | 'video' | 'audio';
  url: string;
  originalUrl?: string;
  alt?: string;
  thumbnail?: string;
  dimensions?: { width: number; height: number };
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
}

export interface NoteUIOptions {
  collapsible?: boolean;
  islFetchStats?: boolean;
  isLoggedIn?: boolean;
  headerSize?: 'small' | 'medium' | 'large';
  depth?: number;
}
