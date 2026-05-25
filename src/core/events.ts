import type { NostrEvent } from '@nostr-dev-kit/ndk';

// ── Auth / User ──────────────────────────────────────────────

export interface UserLoginPayload {
  npub: string;
  pubkey: string;
}

// ── DMs ──────────────────────────────────────────────────────

export interface DMNewMessagePayload {
  message: any;
  conversationWith: string;
}

export interface DMFetchProgressPayload {
  current: number;
  total: number;
}

// ── Notifications ────────────────────────────────────────────

export interface NotificationsNewPayload {
  notification: NostrEvent;
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

export interface ReplyCreatedPayload {
  eventId: string;
}

// ── Relay ────────────────────────────────────────────────────

export interface RelayConnectedPayload {
  url: string;
  latency: number;
}

export interface RelayErrorPayload {
  url: string;
}

// ── Profile ──────────────────────────────────────────────────

export interface ProfileUpdatedPayload {
  pubkey: string;
  [key: string]: any;
}

// ── Layout / Settings ────────────────────────────────────────

export interface LayoutChangedPayload {
  mode: string;
  previousMode: string;
}

export interface FontSizeChangedPayload {
  scale: string;
}

export interface ConnectivityStatusPayload {
  online: boolean;
}

// ── View Tabs ────────────────────────────────────────────────

export interface ViewTabOpenedPayload {
  tab: any;
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
}

// ── Search ───────────────────────────────────────────────────

export interface SearchStartPayload {
  query: string;
}

// ── Mutual Changes ───────────────────────────────────────────

export interface MutualChangesDetectedPayload {
  newFollowers: string[];
  unfollowers: string[];
  timestamp: number;
}

// ── Hashtag ──────────────────────────────────────────────────

export interface HashtagNewPostsPayload {
  hashtag: string;
  count: number;
  events: NostrEvent[];
}

// ── Marketplace ──────────────────────────────────────────────

export interface MarketplaceFrequencyChangePayload {
  frequency: number;
}

// ── NosPress ─────────────────────────────────────────────────

export interface NospressDraftChangedPayload {
  page: any;
  slug: string;
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
  'mute:thread:updated': void;
  'bookmark:updated': void;
  'bookmark:order-changed': void;
  'bookmark:relay-sync-complete': void;
  'tribe:updated': void;
  'list:open': any;
  'list-sync-mode:changed': void;

  // ── Notifications ──────────────────────────
  'notifications:badge-update': void;
  'notifications:new': NotificationsNewPayload;
  'notifications:filtered': void;
  'notifications:priorities-changed': void;
  'article-notification:new': NostrEvent;
  'article-notification:updated': void;

  // ── DMs ────────────────────────────────────
  'dm:badge-update': void;
  'dm:new-message': DMNewMessagePayload;
  'dm:fetch-progress': DMFetchProgressPayload;
  'dm:fetch-complete': void;
  'dm:unsupported': void;

  // ── Notes / Content ────────────────────────
  'note:deleted': NoteDeletedPayload;
  'reply:created': ReplyCreatedPayload;
  'poll:voted': PollVotedPayload;

  // ── Zaps ───────────────────────────────────
  'zap:added': ZapAddedPayload;
  'zapstats:loaded': void;

  // ── Profile ────────────────────────────────
  'profile:updated': ProfileUpdatedPayload;
  'profileMounts:changed': void;

  // ── Relay ──────────────────────────────────
  'relay:connected': RelayConnectedPayload;
  'relay:error': RelayErrorPayload;
  'relay:disconnected': void;
  'relay:health:updated': void;
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

  // ── Timeline ───────────────────────────────
  'timeline:pull-refresh': void;

  // ── Search ─────────────────────────────────
  'globalSearch:start': SearchStartPayload;
  'globalSearch:internal': any;
  'hashtagSearch:start': SearchStartPayload;
  'hashtagSearch:internal': any;
  'profileSearch:complete': void;
  'profileSearch:internal': any;

  // ── Mutual Changes ─────────────────────────
  'mutual-changes:detected': MutualChangesDetectedPayload;
  'mutual-changes:seen': void;
  'mutual-notification:new': any;

  // ── Hashtag Subscriptions ──────────────────
  'hashtag-subscription:updated': void;
  'hashtag:new-posts': HashtagNewPostsPayload;

  // ── Emojis ─────────────────────────────────
  'emojis:updated': void;

  // ── NosPress ───────────────────────────────
  'nospressDraftV2:changed': NospressDraftChangedPayload;
  'nospressList:changed': any;
  'nospressMenus:changed': any;
  'nospressPageIndex:changed': any;
  'nospressSiteSettings:changed': any;
  'nospressMounts:changed': void;

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
