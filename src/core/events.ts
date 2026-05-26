import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { RelayHealthMetrics } from '../services/RelayHealthMonitor';
import type { NotificationEvent } from '../services/orchestration/NotificationsOrchestrator';
import type { ArticleNotification } from '../services/ArticleNotificationService';
import type { DMMessage } from '../services/dm/DMStore';
import type { ViewTab } from '../services/ViewTabManager';
import type { ListingFrequency } from '../addons/marketplace/index';
import type { PersonalEmoji } from '../addons/custom-emojis/EmojiService';
import type { UploadStatus } from '../services/media/compression-types';

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

export interface RelayDisconnectedPayload {
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

export interface BookmarkRelaySyncCompletePayload {
  categoryAssignments: Map<string, string>;
  categories: string[];
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

export interface MarketplaceFrequencyChangePayload {
  frequency: ListingFrequency;
}

// ── NosPress ─────────────────────────────────────────────────

export interface NospressDraftChangedPayload {
  page: any;
  slug: string;
}

export interface NospressMountsChangedPayload {
  mounts: string[];
}

// ── Addon Toggle (shared shape) ──────────────────────────────

export interface AddonTogglePayload {
  enabled: boolean;
}

export interface SettingsTogglePayload {
  disabled?: boolean;
  system?: string;
  mode?: string;
}

// ═════════════════════════════════════════════════════════════
//  Central Event Registry — ALL EventBus events in one place.
//  New events MUST be added here. build-validate enforces this.
// ═════════════════════════════════════════════════════════════

export interface AppEvents {
  // ── Auth ───────────────────────────────────
  'user:login': UserLoginPayload;
  'user:logout': void;
  'auth:login': void;
  'auth:logout': void;

  // ── Follow / Mute / Bookmark / Tribe ───────
  'follow:updated': void;
  'mute:updated': void;
  'mute:thread:updated': MuteThreadUpdatedPayload;
  'bookmark:updated': void;
  'bookmark:order-changed': void;
  'bookmark:relay-sync-complete': BookmarkRelaySyncCompletePayload;
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

  // ── Notes / Content ────────────────────────
  'note:deleted': NoteDeletedPayload;
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
  'relay:disconnected': RelayDisconnectedPayload;
  'relay:health:updated': RelayHealthUpdatedPayload;
  'relays:loaded': void;
  'relays:updated': void;

  // ── Connectivity ───────────────────────────
  'connectivity:status': ConnectivityStatusPayload;
  'connectivity:prolonged-offline': void;

  // ── Layout / Settings ──────────────────────
  'layout:changed': LayoutChangedPayload;
  'font-size:changed': FontSizeChangedPayload;
  'data-saver:toggle': AddonTogglePayload;
  'settings:calendar-system-changed': SettingsTogglePayload;
  'settings:post-truncation-changed': SettingsTogglePayload;
  'settings:layout-mode-changed': SettingsTogglePayload;

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
  'globalSearch:internal': any;
  'hashtagSearch:start': HashtagSearchStartPayload;
  'hashtagSearch:internal': any;
  'profileSearch:complete': ProfileSearchCompletePayload;
  'profileSearch:internal': any;

  // ── Mutual Changes ─────────────────────────
  'mutual-changes:detected': MutualChangesDetectedPayload;
  'mutual-changes:seen': void;
  'mutual-notification:new': MutualNotificationNewPayload;

  // ── Hashtag Subscriptions ──────────────────
  'hashtag-subscription:updated': HashtagSubscriptionUpdatedPayload;
  'hashtag:new-posts': HashtagNewPostsPayload;

  // ── Emojis ─────────────────────────────────
  'emojis:updated': EmojisUpdatedPayload;

  // ── NosPress ───────────────────────────────
  'nospressDraftV2:changed': NospressDraftChangedPayload;
  'nospressList:changed': any;
  'nospressMenus:changed': any;
  'nospressPageIndex:changed': any;
  'nospressSiteSettings:changed': any;
  'nospressMounts:changed': NospressMountsChangedPayload;

  // ── Scheduled Posts ────────────────────────
  'scheduled-posts:changed': void;

  // ── Marketplace ────────────────────────────
  'marketplace:toggle': AddonTogglePayload;
  'marketplace:timeline-toggle': AddonTogglePayload;
  'marketplace:timeline-frequency-change': MarketplaceFrequencyChangePayload;
  'marketplace:profile-listings-toggle': AddonTogglePayload;

  // ── Addon Toggles ─────────────────────────
  'badges:addon-toggle': AddonTogglePayload;
  'bookmarks:addon-toggle': AddonTogglePayload;
  'content-word-filter:toggle': AddonTogglePayload;
  'custom-emojis:addon-toggle': AddonTogglePayload;
  'custom-emojis:toggle': AddonTogglePayload;
  'extended-follows:toggle': AddonTogglePayload;
  'follow-packs:addon-toggle': AddonTogglePayload;
  'follow-packs:toggle': AddonTogglePayload;
  'hashtag-subscriptions:addon-toggle': AddonTogglePayload;
  'marketplace:addon-toggle': AddonTogglePayload;
  'nospress:addon-toggle': AddonTogglePayload;
  'profile-recognition:addon-toggle': AddonTogglePayload;
  'scheduled-posts:addon-toggle': AddonTogglePayload;
  'tribes:addon-toggle': AddonTogglePayload;
  'wallet-balance:addon-toggle': AddonTogglePayload;
  'wordfilter:addon-toggle': AddonTogglePayload;
}

export type AppEventName = keyof AppEvents;
