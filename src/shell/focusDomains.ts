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
   * does not own — they fall through to the classic navigation.
   */
  handleFocusNav?(viewType: string, param?: string): boolean;
}

/** A mounted domain surface, ready to append into the focus column. */
export interface FocusDomainSurface {
  /** Self-rendered root element of the surface. */
  element: HTMLElement;
  /** Optional view handle for pause/resume/destroy lifecycle. */
  view?: FocusDomainSurfaceView;
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
   * Create the domain surface for the focus column. Async so heavy views
   * are dynamically imported (code-split) only when first focused.
   */
  createSurface?: () => Promise<FocusDomainSurface>;
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
    createSurface: socialSurface,
  },
  {
    id: 'articles',
    label: _('Articles'),
    icon: 'icon-articles',
    route: '/articles',
    createSurface: articlesSurface,
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
