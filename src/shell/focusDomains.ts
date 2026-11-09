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

/**
 * Structural contract for the view behind a surface. Kept structural on
 * purpose — the shell must not import concrete view classes.
 */
export interface FocusDomainSurfaceView {
  pause?(): void;
  resume?(): void;
  destroy?(): void;
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

/** The full Timeline as the "Social Media" surface (PoC). */
const socialSurface = async (): Promise<FocusDomainSurface> => {
  const { TimelineView } = await import('../components/views/TimelineView');
  const view = new TimelineView();
  return { element: view.getElement(), view };
};

/** FS primary domains in display order. `(a)` = addon-backed domain. */
export const FOCUS_DOMAINS: readonly FocusDomainDef[] = [
  { id: 'social', label: _('Social Media'), createSurface: socialSurface },
  { id: 'articles', label: _('Articles') },
  { id: 'videos', label: _('Videos') },
  { id: 'recipes', label: _('Recipes') },
  { id: 'notifications', label: _('Notifications') },
  { id: 'messages', label: _('Messages') },
  { id: 'bookmarks', label: _('Bookmarks'), addon: true },
  { id: 'tribes', label: _('Tribes'), addon: true },
  { id: 'follows', label: _('Follows') },
  { id: 'muted', label: _('Muted'), addon: true },
  { id: 'custom-emojis', label: _('Custom Emojis'), addon: true },
  { id: 'live-streams', label: _('Live Streams'), addon: true },
  { id: 'marketplace', label: _('Marketplace'), addon: true },
  { id: 'follow-packs', label: _('Follow Packs'), addon: true },
  { id: 'calendar', label: _('Calendar'), addon: true },
  { id: 'note-taking', label: _('Note taking'), addon: true },
  { id: 'scheduled-posts', label: _('Scheduled Posts'), addon: true },
  { id: 'analytics', label: _('Analytics'), addon: true },
  { id: 'badges', label: _('Badges'), addon: true },
  { id: 'feedback-board', label: _('Feedback Board'), addon: true },
  {
    id: 'hashtag-subscriptions',
    label: _('Hashtag Subscriptions'),
    addon: true,
  },
  { id: 'bulk-delete', label: _('Bulk Delete'), addon: true },
  { id: 'majlis', label: _('Nostr Majlis'), addon: true },
  { id: 'extended-follows', label: _('Extended Follows'), addon: true },
  {
    id: 'follower-notification',
    label: _('Follower Notification'),
    addon: true,
  },
  { id: 'group-chats', label: _('Group Chats'), addon: true },
  { id: 'wallet-balance', label: _('Wallet Balance'), addon: true },
  { id: 'word-filter', label: _('Word Filter'), addon: true },
];
