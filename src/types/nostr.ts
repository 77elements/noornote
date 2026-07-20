/**
 * Nostr Type Definitions
 * Uses NDK types for all Nostr protocol interactions
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { NDKFilter } from '@nostr-dev-kit/ndk';

// Re-export NDK types as application types
export type Event = NostrEvent;
export type Filter = NDKFilter;
export type { NostrEvent, NDKFilter };

/**
 * Extended Event interface with additional metadata
 */
export interface ExtendedEvent extends Event {
  // Relay metadata
  seenOn?: string[];
  firstSeen?: number;

  // Processing metadata
  processed?: boolean;
  cached?: boolean;

  // UI state
  expanded?: boolean;
  reactions?: ReactionSummary;
}

/**
 * Reaction summary for events
 */
export interface ReactionSummary {
  likes: number;
  reposts: number;
  replies: number;
  zaps: number;
}

/**
 * Relay configuration
 */
export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
  priority: number;
  maxRetries: number;
  timeout: number;
}

/**
 * Connection status for relays
 */
export interface RelayStatus {
  url: string;
  connected: boolean;
  error?: string;
  latency?: number;
  lastConnected?: number;
  retryCount: number;
}

/**
 * Subscription configuration
 */
export interface SubscriptionConfig {
  id: string;
  filters: Filter[];
  relays?: string[];
  closeOnEose?: boolean;
  skipVerification?: boolean;
}

/**
 * Event cache entry
 */
export interface CacheEntry {
  event: ExtendedEvent;
  timestamp: number;
  cachedAt: number;  // Timestamp when cached (for TTL expiration)
  source: string;
  ttl: number;       // TTL in milliseconds
}

/**
 * Nostr client configuration
 */
export interface NostrClientConfig {
  defaultRelays: RelayConfig[];
  maxConnections: number;
  reconnectDelay: number;
  eventCacheTTL: number;
  enableBatching: boolean;
  batchSize: number;
  batchDelay: number;
}

/**
 * User profile metadata
 */
export interface UserProfile {
  pubkey: string;
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud06?: string;
  lud16?: string;
}

/**
 * Timeline configuration
 */
export interface TimelineConfig {
  name: string;
  filters: Filter[];
  limit: number;
  since?: number;
  until?: number;
  relays?: string[];
}

/**
 * Custom event kinds (extending NIP-01)
 */
export enum EventKind {
  METADATA = 0,
  TEXT_NOTE = 1,
  RECOMMEND_RELAY = 2,
  CONTACTS = 3,
  ENCRYPTED_DM = 4,
  DELETE = 5,
  REPOST = 6,
  REACTION = 7,
  BADGE_AWARD = 8,
  GROUP_CHAT_MESSAGE = 9,
  GROUP_CHAT_THREADED_REPLY = 10,
  GROUP_THREAD = 11,
  GROUP_THREAD_REPLY = 12,
  SEAL = 13,
  DIRECT_MESSAGE = 14,
  GENERIC_REPOST = 16,
  PICTURE = 20,
  VIDEO_LANDSCAPE = 21,
  VIDEO_PORTRAIT = 22,
  CHANNEL_CREATION = 40,
  CHANNEL_METADATA = 41,
  CHANNEL_MESSAGE = 42,
  CHANNEL_HIDE_MESSAGE = 43,
  CHANNEL_MUTE_USER = 44,
  POLL = 1068,
  COMMENT = 1111,
  FILE_METADATA = 1063,
  LIVE_CHAT_MESSAGE = 1311,
  COMIC_STRIP = 6969,
  ZAP_RECEIPT = 9735,
  HIGHLIGHT = 9802,
  LONG_FORM_CONTENT = 30023,
  LIVE_ACTIVITY = 30311,
}

/**
 * Kinds of user-authored content that can receive reactions, zaps, replies.
 * Single source of truth — add new content kinds here.
 */
export const USER_CONTENT_KINDS: number[] = [
  EventKind.TEXT_NOTE,
  EventKind.PICTURE,
  EventKind.VIDEO_LANDSCAPE,
  EventKind.VIDEO_PORTRAIT,
  EventKind.POLL,
  EventKind.COMMENT,
  EventKind.FILE_METADATA,
  EventKind.COMIC_STRIP,
  EventKind.HIGHLIGHT,
  EventKind.LONG_FORM_CONTENT,
];

/**
 * All kinds the app can render. USER_CONTENT_KINDS + wrapper/system kinds.
 */
export const RENDERABLE_KINDS: number[] = [
  ...USER_CONTENT_KINDS,
  EventKind.REPOST,
  EventKind.ZAP_RECEIPT,
  EventKind.BADGE_AWARD,
  EventKind.LIVE_ACTIVITY,
];

/**
 * NIP-34 (Git on Nostr) event kinds — rendered as lightweight cards
 * linking to gitworkshop.dev. Patch, PR, PR-Update, Issue, Status (Open/
 * Applied/Closed/Draft), Repository Announcement.
 */
export const GIT_EVENT_KINDS: number[] = [1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 30617];

/**
 * Error types for better error handling
 */
export class NostrError extends Error {
  constructor(
    message: string,
    public code: string,
    public relay?: string
  ) {
    super(message);
    this.name = 'NostrError';
  }
}

export class RelayError extends NostrError {
  constructor(message: string, relay: string, public reason?: string) {
    super(message, 'RELAY_ERROR', relay);
    this.name = 'RelayError';
  }
}

export class ValidationError extends NostrError {
  constructor(message: string, public eventId?: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}