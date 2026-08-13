import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { RelayHealthMetrics } from '../services/RelayHealthMonitor';
import type { NotificationEvent } from '../services/orchestration/NotificationsOrchestrator';
import type { ArticleNotification } from '../services/ArticleNotificationService';
import type { DMMessage } from '../services/dm/DMStore';
import type { ViewTab } from '../services/ViewTabManager';
import type { PersonalEmoji } from '../addons/custom-emojis/EmojiService';
import type { UploadStatus } from '../services/media/compression-types';

// Event-name constant for the media-upload status bus event (typed below as
// 'media-upload:status'). Lives here in neutral core/ so both MediaUploadService
// (emitter, services/) and UploadProgressOverlay (listener, components/) can import
// it without a services→components layer inversion.
export const UPLOAD_STATUS_EVENT = 'media-upload:status' as const;

// ── Auth / User ──────────────────────────────────────────────

export interface UserLoginPayload {
  npub: string;
  pubkey: string;
}

// ── DMs ──────────────────────────────────────────────────────

export interface DMNewMessagePayload {
  message: DMMessage;
  conversationWith: string;
}

export interface DMFetchProgressPayload {
  current: number;
  total: number;
}

// ── Notifications ────────────────────────────────────────────

export interface NotificationsNewPayload {
  notification: NotificationEvent;
}

// ── Notes / Content ──────────────────────────────────────────

export interface NoteDeletedPayload {
  eventId: string;
}

/**
 * Fired by NoteService.registerNote() whenever ANY note enters the LRU cache —
 * whether from a feed subscription, an orchestrator fetch, or a one-off lookup.
 * Subscribers (e.g. QuotedNoteRenderer's failed-quote recovery) use this to
 * re-render when a previously-missing note finally arrives via any path,
 * instead of freezing on a "Note not found" box.
 */
export interface NoteCachedPayload {
  eventId: string;
}

export interface ZapAddedPayload {
  noteId: string;
}

export interface PollVotedPayload {
  pollEventId: string;
  results: any;
}

// ── Relay ────────────────────────────────────────────────────

export interface RelayConnectedPayload {
  url: string;
  latency?: number;
}

export interface RelayErrorPayload {
  url: string;
}

export interface RelayHealthUpdatedPayload {
  url: string;
  metrics: RelayHealthMetrics;
}

// ── Profile ──────────────────────────────────────────────────

export interface ProfileUpdatedPayload {
  pubkey: string;
}

export interface ProfileMountsChangedPayload {
  mounts: string[];
}

// ── Layout / Settings ────────────────────────────────────────

export interface LayoutChangedPayload {
  mode: string;
  previousMode: string;
  screenSize?: string;
  forced?: boolean;
}

export interface FontSizeChangedPayload {
  scale: string;
}

export interface ConnectivityStatusPayload {
  online: boolean;
}

// ── View Tabs ────────────────────────────────────────────────

export interface ViewTabOpenedPayload {
  tab: ViewTab;
}

export interface ViewTabClosedPayload {
  tabId: string;
}

export interface ViewTabSwitchedPayload {
  tabId: string;
}

export interface ViewTabLabelUpdatedPayload {
  tabId: string;
  label: string;
  pubkey?: string;
  profilePicUrl?: string;
}

// ── Search ───────────────────────────────────────────────────

export interface SearchStartPayload {
  query: string;
}

export interface HashtagSearchStartPayload {
  hashtag: string;
}

export interface ProfileSearchCompletePayload {
  query: string;
  results: NostrEvent[];
  meta: string;
}

// ── Lists ────────────────────────────────────────────────────

export interface ListOpenPayload {
  listType: string;
  pubkey?: string;
  packId?: string;
  packMode?: 'timeline' | 'edit';
}

export interface ListSyncModeChangedPayload {
  mode: string;
}

export interface MuteThreadUpdatedPayload {
  eventId: string;
}

// ── Mutual Changes ───────────────────────────────────────────

export interface MutualChangesDetectedPayload {
  unfollowCount: number;
  newMutualCount: number;
}

export interface MutualNotificationNewPayload {
  event: NostrEvent;
  type: 'mutual_unfollow' | 'mutual_new';
}

// ── Follower Changes ─────────────────────────────────────────

export interface FollowerChangesDetectedPayload {
  newFollowerCount: number;
}

export interface FollowerNotificationNewPayload {
  event: NostrEvent;
  type: 'follower_new';
}

// ── Community Dhikr (nostr-majlis) ────────────────────────────

export interface DhikrNotificationNewPayload {
  event: NostrEvent;
  type: 'dhikr_round' | 'dhikr_commit' | 'dhikr_complete';
}

// ── Nostrord (NIP-29 group activity) ─────────────────────────

export interface NostrordNotificationNewPayload {
  event: NostrEvent;
  groupName: string;
  /** True when the fresh activity was authored solely by the logged-in user (own-post heads-up). */
  mine?: boolean;
  /** Bare host of the group's relay (e.g. "groups.0xchat.com") for the Nostrord web-client link. */
  groupRelay?: string;
}

// ── Armada (Concord encrypted-community activity) ────────────

export interface ArmadaNotificationNewPayload {
  event: NostrEvent;
  groupName: string;
  /** True when the fresh activity was authored solely by the logged-in user. */
  mine?: boolean;
  /** Bare invite-bundle naddr (kind 33301) for the "Open in Armada" deep link. */
  naddr?: string;
  /** How many fresh gift wraps were observed in this poll window. */
  count?: number;
}

// ── Hashtag ──────────────────────────────────────────────────

export interface HashtagSubscriptionUpdatedPayload {
  hashtag: string;
  subscribed?: boolean;
  includeWithoutHash?: boolean;
}

export interface HashtagNewPostsPayload {
  hashtag: string;
  count: number;
  latestEvent: NostrEvent;
}

// ── Emojis ───────────────────────────────────────────────────

export interface EmojisUpdatedPayload {
  emojis: PersonalEmoji[];
}

// ── Article Notifications ────────────────────────────────────

export interface ArticleNotificationUpdatedPayload {
  pubkey: string;
  subscribed: boolean;
}

// ── Marketplace ──────────────────────────────────────────────

// ── Addon Toggle (shared shape) ──────────────────────────────

export interface AddonTogglePayload {
  enabled: boolean;
}

export interface CalendarSystemChangedPayload {
  system: string;
}

export interface PostTruncationChangedPayload {
  disabled: boolean;
}

export interface SccExcerptLimitChangedPayload {
  limit: number;
}

export interface ArticleFoafDegreeChangedPayload {
  /** Which surface the changed setting applies to. */
  variant: 'main' | 'scc';
  /** New FOAF degree (1, 2, or 3). */
  degree: number;
}

export interface HideSelfRepostsChangedPayload {
  hidden: boolean;
}

// ═════════════════════════════════════════════════════════════
//  Central Event Registry — ALL EventBus events in one place.
//  New events MUST be added here. build-validate enforces this.
// ═════════════════════════════════════════════════════════════

export interface AppEvents {
  // ── Auth ───────────────────────────────────
  'user:login': UserLoginPayload;
  'user:logout': void;

  // ── Follow / Mute / Bookmark / Tribe ───────
  'follow:updated': void;
  'mute:updated': void;
  'mute:thread:updated': MuteThreadUpdatedPayload;
  // Soft mute = notification-only suppression (does NOT hide posts).
  // Emitted on every local mutation; listeners: NotificationsOrchestrator
  // (re-filters notification cache), ProfileView (refreshes button label).
  'soft-mute:updated': void;
  'bookmark:updated': void;
  'bookmark:order-changed': void;
  'tribe:updated': void;
  'list:open': ListOpenPayload;
  'list-sync-mode:changed': ListSyncModeChangedPayload;

  // ── Notifications ──────────────────────────
  'notifications:badge-update': void;
  'notifications:new': NotificationsNewPayload;
  'notifications:filtered': void;
  'notifications:priorities-changed': void;
  'article-notification:new': ArticleNotification;
  'article-notification:updated': ArticleNotificationUpdatedPayload;

  // ── DMs ────────────────────────────────────
  'dm:badge-update': void;
  'dm:new-message': DMNewMessagePayload;
  'dm:fetch-progress': DMFetchProgressPayload;
  'dm:fetch-complete': void;
  'dm:unsupported': void;
  'dm:read': { partnerPubkey: string };
  'dm:all-read': void;
  /** One or more messages in a conversation expired and were locally deleted. */
  'dm:messages-expired': { partnerPubkey: string; count: number };
  /** Per-conversation disappearing setting changed (off / 7d / 30d / 1y / undecided). */
  'dm:disappearing-changed': { partnerPubkey: string; seconds: number | undefined };
  /** Incoming message carried an `expiration` tag while our setting was still undecided. */
  'dm:disappearing-request': { partnerPubkey: string };

  // ── Notes / Content ────────────────────────
  'note:deleted': NoteDeletedPayload;
  'note:cached': NoteCachedPayload;
  'reply:created': NostrEvent;
  'poll:voted': PollVotedPayload;

  // ── Zaps ───────────────────────────────────
  'zap:added': ZapAddedPayload;
  'zapstats:loaded': void;

  // ── Profile ────────────────────────────────
  'profile:updated': ProfileUpdatedPayload;
  'profileMounts:changed': ProfileMountsChangedPayload;

  // ── Relay ──────────────────────────────────
  'relay:connected': RelayConnectedPayload;
  'relay:error': RelayErrorPayload;
  'relay:health:updated': RelayHealthUpdatedPayload;
  'relays:loaded': void;
  'relays:updated': void;

  // ── Connectivity ───────────────────────────
  'connectivity:status': ConnectivityStatusPayload;
  'connectivity:prolonged-offline': void;

  // ── Layout / Settings ──────────────────────
  'layout:changed': LayoutChangedPayload;
  'font-size:changed': FontSizeChangedPayload;
  'settings:calendar-system-changed': CalendarSystemChangedPayload;
  'settings:post-truncation-changed': PostTruncationChangedPayload;
  'settings:scc-excerpt-limit-changed': SccExcerptLimitChangedPayload;
  'settings:article-foaf-degree-changed': ArticleFoafDegreeChangedPayload;
  'settings:hide-self-reposts-changed': HideSelfRepostsChangedPayload;

  // ── View Tabs ──────────────────────────────
  'view-tab:opened': ViewTabOpenedPayload;
  'view-tab:closed': ViewTabClosedPayload;
  'view-tab:switched': ViewTabSwitchedPayload;
  'view-tab:label-updated': ViewTabLabelUpdatedPayload;

  // ── Media Upload ────────────────────────────
  'media-upload:status': UploadStatus;

  // ── Timeline ───────────────────────────────
  'timeline:pull-refresh': void;

  // ── Search ─────────────────────────────────
  'globalSearch:start': SearchStartPayload;
  'hashtagSearch:start': HashtagSearchStartPayload;
  'profileSearch:complete': ProfileSearchCompletePayload;

  // ── Mutual Changes ─────────────────────────
  'mutual-changes:detected': MutualChangesDetectedPayload;
  'mutual-changes:seen': void;
  'mutual-notification:new': MutualNotificationNewPayload;

  // ── Follower Changes ───────────────────────
  'follower-changes:detected': FollowerChangesDetectedPayload;
  'follower-changes:seen': void;
  'follower-notification:new': FollowerNotificationNewPayload;
  'dhikr-notification:new': DhikrNotificationNewPayload;
  'nostrord-notification:new': NostrordNotificationNewPayload;
  'armada-notification:new': ArmadaNotificationNewPayload;
  'armada:addon-toggle': { enabled: boolean };

  // ── Hashtag Subscriptions ──────────────────
  'hashtag-subscription:updated': HashtagSubscriptionUpdatedPayload;
  'hashtag:new-posts': HashtagNewPostsPayload;

  // ── Emojis ─────────────────────────────────
  'emojis:updated': EmojisUpdatedPayload;

  // ── Scheduled Posts ────────────────────────
  'scheduled-posts:changed': void;

  // ── Nostr-Majlis ───────────────────────────
  'nostr-majlis:settings-changed': void;
  'nostr-majlis:dhikr-changed': void;

  // ── Marketplace ────────────────────────────
  'marketplace:toggle': AddonTogglePayload;
  'marketplace:timeline-toggle': AddonTogglePayload;

  // ── Addon Toggles ─────────────────────────
  'badges:addon-toggle': AddonTogglePayload;
  'bookmarks:addon-toggle': AddonTogglePayload;
  'bulk-delete:addon-toggle': AddonTogglePayload;
  'content-word-filter:toggle': AddonTogglePayload;
  'custom-emojis:addon-toggle': AddonTogglePayload;
  'extended-follows:toggle': AddonTogglePayload;
  'follow-packs:addon-toggle': AddonTogglePayload;
  'follow-packs:toggle': AddonTogglePayload;
  'follower-notification:addon-toggle': AddonTogglePayload;
  'hashtag-subscriptions:addon-toggle': AddonTogglePayload;
  'live-streams-player:addon-toggle': AddonTogglePayload;
  'marketplace:addon-toggle': AddonTogglePayload;
  'note-taking:addon-toggle': AddonTogglePayload;
  'nostr-majlis:addon-toggle': AddonTogglePayload;
  'nostrord:addon-toggle': AddonTogglePayload;
  'profile-recognition:addon-toggle': AddonTogglePayload;
  'scheduled-posts:addon-toggle': AddonTogglePayload;
  'tribes:addon-toggle': AddonTogglePayload;
  'wallet-balance:addon-toggle': AddonTogglePayload;
  'wordfilter:addon-toggle': AddonTogglePayload;
}

export type AppEventName = keyof AppEvents;
