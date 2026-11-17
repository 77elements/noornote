/**
 * Focus domains (v2) — the config-driven registry of the FS primary
 * objects (docs/todos/v2-focus-ui.md, "Primär"). The shell/stage knows no
 * domain-ifs: every domain is a typed entry in this registry; surfaces are
 * created lazily by the stage when a circle takes the focus.
 *
 * PoC status: only "Social Media" has a real surface (the full Timeline).
 * All other entries render as circles but have no surface yet — they stay
 * placeholders until their views get wired (one entry at a time).
 *
 * Note: "Live Streams" lives behind the AddonLoader; its surface will go
 * through the addon runtime (not a direct view import) when it is wired.
 */

import { _ } from '../i18n';
import type { FocusUrlState } from './focusUrlState';
import { articlesSurface } from './focusArticlesSurface';
import { socialSurface } from './focusSocialSurface';
import { messagesSurface } from './focusMessagesSurface';
import { bookmarksSurface } from './focusBookmarksSurface';
import { followsSurface } from './focusFollowsSurface';
import { marketplaceSurface } from './focusMarketplaceSurface';
import { focusLiveStreamsSurface } from './focusLiveStreamsSurface';
import { focusTabbedObjectSurface } from './focusTabbedObjectSurface';
import { focusAddonObjectSurface } from './focusAddonObjectSurface';
import { focusSearchSurface } from './focusSearchSurface';
import { focusRecipesSurface } from './focusRecipesSurface';
import { mediaSurface } from './focusMediaSurface';
import { mutesSurface } from './focusMutesSurface';
import { profileSurface } from './focusProfileSurface';
import { tribesSurface } from './focusTribesSurface';
import { notificationsSurface } from './focusNotificationsSurface';
import {
  articlesSettings,
  bookmarksSettings,
  followsSettings,
  mutesSettings,
  notificationsSettings,
  profileSettings,
  socialSettings,
} from './focusSettings';

/**
 * Structural contract for the view behind a surface. Kept structural on
 * purpose — the shell must not import concrete view classes.
 */
export interface FocusDomainSurfaceView {
  pause?(): void;
  resume?(): void;
  destroy?(): void;
  /**
   * Focus navigation seam: render a view type inside this surface's
   * column (note/article details). Return false for types the surface
   * does not own — the stage then routes them to the domain that owns
   * the type (cross-object switch) or, if none, to the classic
   * navigation.
   */
  handleFocusNav?(viewType: string, param?: string): boolean;
  /**
   * Open the surface's detail for a seam param, resolving once the
   * detail element is mounted (FocusListDetailSurface provides it). The
   * stage awaits this on cross-object handoffs so the morph lands on
   * the final content instead of an intermediate list. Param-less calls
   * route to the surface's secondary detail when one is configured.
   */
  openDetail?(param?: string): Promise<void>;
  /**
   * Return to the surface's root list state: destroy any in-column
   * detail and re-attach the list. Called when the surface is detached
   * from the focus column (close), so reopening always starts at the
   * list — never in a stale detail.
   */
  reset?(): void;
  /**
   * Per-object settings override for the ED-b (gear action): while this
   * surface shows its secondary detail, it can swap the domain's default
   * settings panel for a detail-specific one (e.g. the scheduled posts
   * list while the composer is open). Resolve null → the stage uses
   * def.createSettings().
   */
  getSettingsForCurrentState?(): Promise<FocusSettingsView | null>;
  /**
   * Leave the in-column detail and return to the surface's list (the
   * object's back action button — only shown while a detail is open).
   */
  back?(): void;
  /**
   * Optional back-veto: return false to defer the back (e.g. the
   * composer asks "Save as draft?" and re-triggers back afterwards).
   */
  confirmBack?(): boolean;
  /**
   * Sync the browser URL with the surface's current state (list ↔
   * detail). Called by the stage when a surface (re)mounts, so a
   * preserved detail keeps its own route.
   */
  syncUrl?(): void;
  /**
   * History-restore: bring the surface back to the state a parsed URL
   * describes (back/forward/deep-link). The URL is already correct —
   * implementations must not push another history step (pushUrl's
   * same-path guard makes the surface's own sync calls no-ops).
   */
  restoreState?(state: FocusUrlState): Promise<void> | void;
}

/** A mounted domain surface, ready to attach into the focus column. */
export interface FocusDomainSurface {
  /**
   * Mount the surface's content into the stage's column slot
   * (.focus-object__content). The slot is the domain's content root —
   * surfaces own their content, the stage owns the slot.
   */
  attach(slot: HTMLElement): void;
  /** Detach the surface's content from the slot (content stays cached). */
  detach(): void;
  /** Optional view handle for pause/resume/destroy lifecycle. */
  view?: FocusDomainSurfaceView;
  /**
   * The surface's scope is the visit itself (on-demand addon objects):
   * leaving the object destroys the view and evicts the cached surface —
   * the addon runtime unloads (view.destroy → deactivateOnDemand).
   * Non-ephemeral surfaces pause + reset and stay cached.
   */
  ephemeral?: boolean;
}

/**
 * Per-object settings panel for the ED-b bottom drawer (the gear action
 * button). Panels compose their OWN small setting list from the SAME
 * storage helpers the classic settings use — identical storage keys,
 * identical TypedEventBus events — so both UIs share one state. The v1
 * sections are monoliths (theme/language/layout mixed with feed toggles)
 * and are deliberately NOT mounted here: a panel carries only what its
 * object needs. The classic UI settings dissolve step by step as objects
 * gain panels.
 */
export interface FocusSettingsView {
  mount(el: HTMLElement): void;
  destroy(): void;
}

/**
 * The ED-b bottom drawer API the stage needs for object settings.
 * Implemented by the shell's EdgeDrawer via structural typing — the
 * stage never imports the shell.
 */
export interface FocusSettingsDrawer {
  panel: HTMLElement;
  open(): void;
  close(): void;
  /** Callback fired on every transition to closed (tab, drag, program). */
  setOnClosed(cb: (() => void) | null): void;
}

export interface FocusDomainDef {
  /** Stable id, also carried as data-domain-id on the FS object. */
  id: string;
  /** Translated label shown in the circle (i18n-ready at module load). */
  label: string;
  /**
   * Sprite symbol id (public/icons.svg) shown as the circle's icon. Same
   * sprite the classic navigation uses.
   */
  icon?: string;
  /**
   * URL the browser shows while this domain holds the focus ('' = home
   * grid). Social uses the new /timeline; the other domains keep their
   * classic URLs once their surfaces are wired.
   */
  route?: string;
  /**
   * View types this domain's surface can render in the focus navigation
   * seam. Cross-object routing: when the ACTIVE surface declines a view
   * type, the stage switches the focus to the domain that owns it (e.g.
   * a quoted-article click in the timeline morphs to the Articles
   * object). Declared on the def — surfaces are created lazily, so
   * ownership cannot be queried off an instance.
   */
  viewTypes?: string[];
  /**
   * Create the domain surface for the focus column. Async so heavy views
   * are dynamically imported (code-split) only when first focused.
   */
  createSurface?: () => Promise<FocusDomainSurface>;
  /**
   * Per-object settings panel (ED-b bottom drawer, gear action button).
   * Presence = the object shows the settings action at all. Sync — the
   * panels are lightweight (Switch/NnDropdown compositions), unlike the
   * surfaces.
   */
  createSettings?: () => FocusSettingsView;
  /**
   * Addon-backed domain: the object is provided by an AddonLoader addon.
   * Marked now, rendered differently later (docs/todos/v2-focus-ui.md).
   */
  addon?: boolean;
}

/** FS primary domains in display order. `(a)` = addon-backed domain. */
export const FOCUS_DOMAINS: readonly FocusDomainDef[] = [
  {
    id: 'social',
    label: _('Social Media'),
    icon: 'icon-home',
    route: '/timeline',
    viewTypes: ['single-note', 'new-note'],
    createSurface: socialSurface,
    createSettings: socialSettings,
  },
  {
    id: 'articles',
    label: _('Articles'),
    icon: 'icon-articles',
    route: '/articles',
    viewTypes: ['article', 'write-article'],
    createSurface: articlesSurface,
    createSettings: articlesSettings,
  },
  {
    id: 'media',
    label: _('Media'),
    icon: 'icon-video',
    route: '/media',
    viewTypes: ['write-video'],
    createSurface: mediaSurface,
  },
  {
    id: 'recipes',
    label: _('Recipes'),
    icon: 'icon-book-open',
    route: '/recipes',
    // The v1 scc recipes tab as its own object; card clicks go to
    // /article/:naddr (the stage morphs to the Articles object).
    createSurface: focusRecipesSurface,
  },
  {
    id: 'notifications',
    label: _('Notifications'),
    icon: 'icon-notifications',
    route: '/notifications',
    createSurface: notificationsSurface,
    createSettings: notificationsSettings,
  },
  {
    id: 'messages',
    label: _('Messages'),
    icon: 'icon-email',
    route: '/messages',
    viewTypes: ['messages'],
    createSurface: messagesSurface,
  },
  {
    id: 'bookmarks',
    label: _('Bookmarks'),
    icon: 'icon-bookmark',
    route: '/lists',
    createSurface: bookmarksSurface,
    createSettings: bookmarksSettings,
  },
  {
    id: 'tribes',
    label: _('Tribes'),
    icon: 'icon-tribe',
    route: '/tribes',
    viewTypes: ['tribes'],
    createSurface: tribesSurface,
    // Always-on (never on-demand), no settings — the object has no gear.
    // Every manager change emits tribe:updated; the TV tab row rebuilds
    // on it (TimelineView), the TV "Edit tribes" link routes here via
    // the 'tribes' view type (focus navigation seam).
  },
  {
    id: 'follows',
    label: _('Follows'),
    icon: 'icon-follows',
    route: '/follow-list',
    viewTypes: [],
    createSurface: followsSurface,
    createSettings: followsSettings,
    // Always-on, extended features merged in. Settings (gear): the
    // private-lists toggle from the classic Settings → Privacy section.
  },
  {
    id: 'muted',
    label: _('Muted'),
    icon: 'icon-mute',
    addon: true,
    route: '/muted',
    createSurface: mutesSurface,
    createSettings: mutesSettings,
  },
  {
    id: 'profile',
    label: _('Profile'),
    icon: 'icon-profile',
    route: '/profile',
    viewTypes: ['profile', 'profile-edit'],
    createSurface: profileSurface,
    createSettings: profileSettings,
    // list = own profile (circle click), detail = foreign profile (seam
    // 'profile'), secondary = the flat profile editor (/profile/edit).
  },
  {
    id: 'search',
    label: _('Search'),
    icon: 'icon-search',
    route: '/search',
    // The Search object (v2): its own circle. Result clicks navigate via
    // the Router (shared detail routes) — the stage morphs to the owning
    // object (SNV in Social, DMV in Messages).
    createSurface: focusSearchSurface,
  },
  {
    id: 'custom-emojis',
    label: _('Custom Emojis'),
    icon: 'icon-emoji',
    addon: true,
    route: '/custom-emojis',
    // On-demand addon object: entering the object loads the addon,
    // leaving it unloads again (ephemeral surface).
    createSurface: focusAddonObjectSurface({
      ephemeral: true,
      load: async () => {
        const { CustomEmojisView } = await import(
          '../addons/custom-emojis/CustomEmojisView'
        );
        return new CustomEmojisView();
      },
    }),
  },
  {
    id: 'live-streams',
    label: _('Live Streams'),
    icon: 'icon-play',
    addon: true,
    route: '/live-streams',
    viewTypes: ['live-stream-detail'],
    // On-demand addon object (ephemeral surface): entering the object
    // loads the addon, leaving it unloads again — unless the sidebar
    // widget is on or a background stream stays pinned (always-on
    // reasons, see live-streams/index.ts isLiveStreamsAutoLoaded).
    // list = the addon view (switches + live feed), detail = a stream
    // (/live-streams/stream/:naddr, inline player + background pin).
    createSurface: focusLiveStreamsSurface,
  },
  {
    id: 'marketplace',
    label: _('Marketplace'),
    icon: 'icon-shopping-bag',
    addon: true,
    route: '/marketplace',
    viewTypes: ['listing', 'write-listing', 'edit-listing'],
    createSurface: marketplaceSurface,
    // list = the listing feed, detail = a listing (/listing/:naddr),
    // secondary = the listing composer (/marketplace/post).
  },
  {
    id: 'follow-packs',
    label: _('Follow Packs'),
    icon: 'icon-tribes-circles',
    addon: true,
    route: '/follow-packs',
    viewTypes: ['follow-pack'],
    createSurface: async () => {
      const { FocusListDetailSurface } = await import(
        './focusListDetailSurface'
      );
      const { FollowPacksView } = await import(
        '../addons/follow-packs/FollowPacksView'
      );
      const surface = new FocusListDetailSurface({
        navViewType: 'follow-pack',
        listRoute: '/follow-packs',
        detailRoute: naddr => `/follow-pack/${naddr}`,
        createList: async () => new FollowPacksView(),
        createDetail: async naddr => {
          const { FollowPackDetailView } = await import(
            '../components/views/FollowPackDetailView'
          );
          return new FollowPackDetailView(naddr);
        },
      });
      return surface.asSurface();
    },
  },
  {
    id: 'calendar',
    label: _('Calendar'),
    icon: 'icon-calendar',
    addon: true,
    route: '/calendar',
    // Tabbed object: detail = the booking tab deep link
    // (/calendar/booking); personal is the default tab (bare route).
    createSurface: focusTabbedObjectSurface({
      create: async initialTab => {
        const { CalendarAddonView } = await import(
          '../addons/calendar/CalendarAddonView'
        );
        return new CalendarAddonView(initialTab ?? undefined);
      },
      tabFromState: state =>
        state.kind === 'detail' && state.param === 'booking' ? 'booking' : null,
      defaultTab: 'personal',
      tabUrl: tab => (tab === 'booking' ? '/calendar/booking' : '/calendar'),
    }),
  },
  {
    id: 'note-taking',
    label: _('Note taking'),
    icon: 'icon-edit',
    addon: true,
    route: '/note-taking',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { NoteTakingAddonView } = await import(
          '../addons/note-taking/NoteTakingAddonView'
        );
        return new NoteTakingAddonView();
      },
    }),
  },
  {
    id: 'scheduled-posts',
    label: _('Scheduled Posts'),
    icon: 'icon-clock',
    addon: true,
    route: '/scheduled-posts',
    // On-demand addon object: entering the object loads the addon,
    // leaving it unloads again (ephemeral surface).
    createSurface: focusAddonObjectSurface({
      ephemeral: true,
      load: async () => {
        const { ScheduledPostsAddonView } = await import(
          '../addons/scheduled-posts/ScheduledPostsAddonView'
        );
        return new ScheduledPostsAddonView();
      },
    }),
  },
  {
    id: 'analytics',
    label: _('Analytics'),
    icon: 'icon-trending-up',
    addon: true,
    route: '/analytics',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { AnalyticsAddonView } = await import(
          '../addons/analytics/AnalyticsAddonView'
        );
        return new AnalyticsAddonView();
      },
    }),
  },
  {
    id: 'badges',
    label: _('Badges'),
    icon: 'icon-badge',
    addon: true,
    route: '/badges',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { BadgesView } = await import('../addons/badges/BadgesView');
        return new BadgesView();
      },
    }),
  },
  {
    id: 'feedback-board',
    label: _('Feedback Board'),
    icon: 'icon-grid-dots',
    addon: true,
    route: '/feedback-board',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { FeedbackBoardAddonView } = await import(
          '../addons/feedback-board/FeedbackBoardView'
        );
        return new FeedbackBoardAddonView();
      },
      // '/feedback-board/:naddr' opens the ticket modal
      // (deep link — the view ignores invalid/non-board naddrs).
      restore: (handle, state) => {
        if (state.kind === 'detail' && state.param) {
          void (
            handle as unknown as {
              openDeepLink(naddr: string): Promise<void>;
            }
          ).openDeepLink(state.param);
        }
      },
    }),
  },
  {
    id: 'hashtag-subscriptions',
    label: _('Hashtag Subscriptions'),
    icon: 'icon-tag',
    addon: true,
    route: '/hashtag-subscriptions',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { HashtagSubscriptionsAddonView } = await import(
          '../addons/hashtag-subscriptions/HashtagSubscriptionsAddonView'
        );
        return new HashtagSubscriptionsAddonView();
      },
    }),
  },
  {
    id: 'bulk-delete',
    label: _('Bulk Delete'),
    icon: 'icon-trash',
    addon: true,
    route: '/bulk-delete',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { BulkDeleteView } = await import(
          '../addons/bulk-delete/BulkDeleteView'
        );
        return new BulkDeleteView();
      },
    }),
  },
  {
    id: 'majlis',
    label: _('Nostr Majlis'),
    icon: 'icon-globe',
    addon: true,
    route: '/nostr-majlis',
    // On-demand addon object (ephemeral surface): entering the object
    // loads the addon, leaving it unloads again — unless one of the two
    // majlis widgets is active (always-on reasons, see
    // nostr-majlis/index.ts isNostrMajlisAutoLoaded). Detail = a tab
    // deep link (/nostr-majlis/:tab; salah is the default tab,
    // the bare route).
    createSurface: focusTabbedObjectSurface({
      ephemeral: true,
      create: async initialTab => {
        const { NostrMajlisAddonView } = await import(
          '../addons/nostr-majlis/NostrMajlisAddonView'
        );
        return new NostrMajlisAddonView(initialTab ?? undefined);
      },
      tabFromState: state =>
        state.kind === 'detail' && state.param && state.param !== 'salah'
          ? state.param
          : null,
      defaultTab: 'salah',
      tabUrl: tab => (tab ? `/nostr-majlis/${tab}` : '/nostr-majlis'),
    }),
  },
  {
    id: 'follower-notification',
    label: _('Follower Notification'),
    icon: 'icon-bell',
    addon: true,
    route: '/follower-notification',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { FollowerNotificationAddonView } = await import(
          '../addons/follower-notification/FollowerNotificationAddonView'
        );
        return new FollowerNotificationAddonView();
      },
    }),
  },
  {
    id: 'group-chats',
    label: _('Group Chats'),
    icon: 'icon-message',
    addon: true,
    route: '/group-chats',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { GroupChatsAddonView } = await import(
          '../addons/group-chats/GroupChatsAddonView'
        );
        return new GroupChatsAddonView();
      },
    }),
  },
  {
    id: 'wallet-balance',
    label: _('Wallet Balance'),
    icon: 'icon-zap',
    addon: true,
    route: '/wallet-balance',
    createSurface: focusAddonObjectSurface({
      load: async () => {
        const { WalletBalanceAddonView } = await import(
          '../addons/wallet-balance/WalletBalanceAddonView'
        );
        return new WalletBalanceAddonView();
      },
    }),
  },
  {
    id: 'word-filter',
    label: _('Word Filter'),
    icon: 'icon-eye-closed',
    addon: true,
    // Classic slug (no hyphen) — keep the v1 URL canonical. On-demand
    // addon object: ON while the object is open, OFF after leaving —
    // unless words are configured (always-on, see isWordFilterAutoLoaded).
    route: '/wordfilter',
    createSurface: focusAddonObjectSurface({
      ephemeral: true,
      load: async () => {
        const { WordFilterAddonView } = await import(
          '../addons/content-word-filter/WordFilterAddonView'
        );
        return new WordFilterAddonView();
      },
    }),
  },
];
