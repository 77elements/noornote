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
import { articlesSurface } from './focusArticlesSurface';
import { socialSurface } from './focusSocialSurface';
import { articlesSettings, socialSettings } from './focusSettings';

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
   * the final content instead of an intermediate list.
   */
  openDetail?(param: string): Promise<void>;
  /**
   * Return to the surface's root list state: destroy any in-column
   * detail and re-attach the list. Called when the surface is detached
   * from the focus column (close), so reopening always starts at the
   * list — never in a stale detail.
   */
  reset?(): void;
  /**
   * Leave the in-column detail and return to the surface's list (the
   * object's back action button — only shown while a detail is open).
   */
  back?(): void;
  /**
   * Sync the browser URL with the surface's current state (list ↔
   * detail). Called by the stage when a surface (re)mounts, so a
   * preserved detail keeps its own route.
   */
  syncUrl?(): void;
}

/** A mounted domain surface, ready to append into the focus column. */
export interface FocusDomainSurface {
  /** Self-rendered root element of the surface. */
  element: HTMLElement;
  /** Optional view handle for pause/resume/destroy lifecycle. */
  view?: FocusDomainSurfaceView;
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
    viewTypes: ['single-note'],
    createSurface: socialSurface,
    createSettings: socialSettings,
  },
  {
    id: 'articles',
    label: _('Articles'),
    icon: 'icon-articles',
    route: '/articles',
    viewTypes: ['article'],
    createSurface: articlesSurface,
    createSettings: articlesSettings,
  },
  { id: 'videos', label: _('Videos'), icon: 'icon-video' },
  { id: 'recipes', label: _('Recipes'), icon: 'icon-book-open' },
  {
    id: 'notifications',
    label: _('Notifications'),
    icon: 'icon-notifications',
  },
  { id: 'messages', label: _('Messages'), icon: 'icon-email' },
  {
    id: 'bookmarks',
    label: _('Bookmarks'),
    icon: 'icon-bookmark',
    addon: true,
  },
  { id: 'tribes', label: _('Tribes'), icon: 'icon-tribe', addon: true },
  { id: 'follows', label: _('Follows'), icon: 'icon-follows' },
  { id: 'muted', label: _('Muted'), icon: 'icon-mute', addon: true },
  { id: 'profile', label: _('Profile'), icon: 'icon-profile' },
  {
    id: 'custom-emojis',
    label: _('Custom Emojis'),
    icon: 'icon-emoji',
    addon: true,
  },
  {
    id: 'live-streams',
    label: _('Live Streams'),
    icon: 'icon-play',
    addon: true,
  },
  {
    id: 'marketplace',
    label: _('Marketplace'),
    icon: 'icon-shopping-bag',
    addon: true,
  },
  {
    id: 'follow-packs',
    label: _('Follow Packs'),
    icon: 'icon-tribes-circles',
    addon: true,
  },
  { id: 'calendar', label: _('Calendar'), icon: 'icon-calendar', addon: true },
  {
    id: 'note-taking',
    label: _('Note taking'),
    icon: 'icon-edit',
    addon: true,
  },
  {
    id: 'scheduled-posts',
    label: _('Scheduled Posts'),
    icon: 'icon-clock',
    addon: true,
  },
  {
    id: 'analytics',
    label: _('Analytics'),
    icon: 'icon-trending-up',
    addon: true,
  },
  { id: 'badges', label: _('Badges'), icon: 'icon-badge', addon: true },
  {
    id: 'feedback-board',
    label: _('Feedback Board'),
    icon: 'icon-grid-dots',
    addon: true,
  },
  {
    id: 'hashtag-subscriptions',
    label: _('Hashtag Subscriptions'),
    icon: 'icon-tag',
    addon: true,
  },
  {
    id: 'bulk-delete',
    label: _('Bulk Delete'),
    icon: 'icon-trash',
    addon: true,
  },
  { id: 'majlis', label: _('Nostr Majlis'), icon: 'icon-globe', addon: true },
  {
    id: 'extended-follows',
    label: _('Extended Follows'),
    icon: 'icon-user-16',
    addon: true,
  },
  {
    id: 'follower-notification',
    label: _('Follower Notification'),
    icon: 'icon-bell',
    addon: true,
  },
  {
    id: 'group-chats',
    label: _('Group Chats'),
    icon: 'icon-message',
    addon: true,
  },
  {
    id: 'wallet-balance',
    label: _('Wallet Balance'),
    icon: 'icon-zap',
    addon: true,
  },
  {
    id: 'word-filter',
    label: _('Word Filter'),
    icon: 'icon-eye-closed',
    addon: true,
  },
];
