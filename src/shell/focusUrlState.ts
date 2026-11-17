/**
 * Focus URL → state mapper (v2).
 *
 * The focus shell drives its surfaces from the focus navigation seam, and
 * every seam navigation now records a REAL history step (Router.pushUrl).
 * Back/forward (Global Back button, browser buttons, hardware back) walk
 * the Router's custom history stack — the shell must turn the resulting
 * path back into shell state: which object to focus and which state
 * (list / detail / secondary) to restore on its surface.
 *
 * Pure parsing — no DOM, no services — so the table is unit-testable.
 * The /note/:nevent detail route is shared by the social and the
 * notifications domain; the caller resolves that ambiguity with the
 * currently active object (stay in the object the note was opened from).
 */

/** A shell state a parsed URL maps to. */
export interface FocusUrlState {
  /** FocusDomainDef.id of the owning object. */
  defId: string;
  /** list = object root, detail = param detail, secondary = param-less detail. */
  kind: 'list' | 'detail' | 'secondary';
  /** Detail param (npub / nevent / naddr / pubkey) — detail states only. */
  param?: string;
}

/** Detail routes shared by more than one domain — resolve via activeId. */
const SHARED_DETAIL_ROUTES: Record<string, string[]> = {
  // nevent detail: social owns it primarily, notifications reuses it.
  note: ['social', 'notifications'],
};

/**
 * Addon objects' list routes. The SHORT one-segment URLs are canonical
 * (v2 pushes them); the classic /addons/:slug forms stay as aliases so
 * every widget click / deep link / old bookmark targeting an addon view
 * still lands on the owning FV object.
 */
const ADDON_LIST_ROUTES: Record<string, string> = {
  'custom-emojis': 'custom-emojis',
  'follow-packs': 'follow-packs',
  calendar: 'calendar',
  'note-taking': 'note-taking',
  'scheduled-posts': 'scheduled-posts',
  analytics: 'analytics',
  badges: 'badges',
  'feedback-board': 'feedback-board',
  'hashtag-subscriptions': 'hashtag-subscriptions',
  'bulk-delete': 'bulk-delete',
  'nostr-majlis': 'majlis',
  'follower-notification': 'follower-notification',
  'group-chats': 'group-chats',
  'wallet-balance': 'wallet-balance',
  // v1 slug has no hyphen — keep it as the canonical URL.
  wordfilter: 'word-filter',
  // /addons/live-streams is a classic alias of the canonical /live-streams.
  'live-streams': 'live-streams',
};

/**
 * Parse a pathname into a focus shell state. Returns null for paths the
 * shell does not own (classic routes like /settings, addon objects
 * without routes, unknown) — the caller leaves those alone.
 */
export function parseFocusUrl(
  path: string,
  activeDefId?: string | null
): FocusUrlState | null {
  const segments = path.split('/').filter(Boolean);

  // Two-segment param routes first (exact second segments below).
  if (segments.length === 2) {
    const [head, tail] = segments as [string, string];
    switch (head) {
      case 'note': {
        const defId = resolveShared('note', activeDefId);
        return { defId, kind: 'detail', param: tail };
      }
      case 'article':
        return { defId: 'articles', kind: 'detail', param: tail };
      case 'listing':
        return { defId: 'marketplace', kind: 'detail', param: tail };
      case 'marketplace':
        // '/marketplace/post' is the listing composer (secondary detail).
        if (tail === 'post') {
          return { defId: 'marketplace', kind: 'secondary' };
        }
        return null;
      case 'articles':
        // '/articles/post' is the article composer (secondary detail);
        // no other two-segment articles route exists.
        if (tail === 'post') {
          return { defId: 'articles', kind: 'secondary' };
        }
        return null;
      case 'messages':
        return { defId: 'messages', kind: 'detail', param: tail };
      case 'profile':
        // '/profile/edit' is the composer-style edit view; every other
        // second segment is a profile param (npub).
        if (tail === 'edit') {
          return { defId: 'profile', kind: 'secondary' };
        }
        return { defId: 'profile', kind: 'detail', param: tail };
      case 'media':
        // '/media/post' is the video composer (secondary detail); the
        // media surface has no param detail (notes morph to social).
        if (tail === 'post') {
          return { defId: 'media', kind: 'secondary' };
        }
        return null;
      case 'addons': {
        // Addon objects' list states (/addons/<slug> — classic aliases
        // of the canonical short routes).
        const defId = ADDON_LIST_ROUTES[tail];
        return defId ? { defId, kind: 'list' } : null;
      }
      case 'follow-pack':
        // '/follow-pack/:naddr' is a follow pack detail (FollowPacks).
        return { defId: 'follow-packs', kind: 'detail', param: tail };
      case 'nostr-majlis':
        // '/nostr-majlis/:tab' deep-links a majlis tab (canonical short
        // form of /addons/nostr-majlis/:tab).
        return { defId: 'majlis', kind: 'detail', param: tail };
      case 'feedback-board':
        // '/feedback-board/:naddr' opens a ticket (canonical short form).
        return { defId: 'feedback-board', kind: 'detail', param: tail };
      case 'calendar':
        // '/calendar/booking' deep-links the booking tab.
        if (tail === 'booking') {
          return { defId: 'calendar', kind: 'detail', param: tail };
        }
        return null;
      default:
        return null;
    }
  }

  // Three-segment param routes (composer edit flows + stream detail).
  if (segments.length === 3) {
    const [head, tail, param] = segments as [string, string, string];
    if (head === 'marketplace' && tail === 'edit') {
      return { defId: 'marketplace', kind: 'secondary', param };
    }
    // '/live-streams/stream/:naddr' is a stream detail (inline player).
    if (head === 'live-streams' && tail === 'stream') {
      return { defId: 'live-streams', kind: 'detail', param };
    }
    // '/addons/nostr-majlis/:tab' deep-links a majlis tab (dhikr
    // notification, "Show tafsir" quran widget link — classic alias of
    // the canonical /nostr-majlis/:tab).
    if (head === 'addons' && tail === 'nostr-majlis') {
      return { defId: 'majlis', kind: 'detail', param };
    }
    // '/addons/calendar/booking' deep-links the booking tab.
    if (head === 'addons' && tail === 'calendar' && param === 'booking') {
      return { defId: 'calendar', kind: 'detail', param };
    }
    // '/addons/feedback-board/:naddr' opens a ticket (deep link).
    if (head === 'addons' && tail === 'feedback-board') {
      return { defId: 'feedback-board', kind: 'detail', param };
    }
    return null;
  }

  // Four-segment param routes (classic aliases).
  if (segments.length === 4) {
    const [head, slug, tail, param] = segments as [
      string,
      string,
      string,
      string,
    ];
    if (head === 'addons' && slug === 'live-streams' && tail === 'stream') {
      return { defId: 'live-streams', kind: 'detail', param };
    }
    return null;
  }

  // One-segment routes: the objects' list states. Addon objects use
  // their short canonical slugs (the /addons/<slug> aliases above).
  if (segments.length === 1) {
    const [slug] = segments as [string];
    const addonDefId = ADDON_LIST_ROUTES[slug];
    if (addonDefId) return { defId: addonDefId, kind: 'list' };
    switch (slug) {
      case 'timeline':
        return { defId: 'social', kind: 'list' };
      case 'articles':
        return { defId: 'articles', kind: 'list' };
      case 'notifications':
        return { defId: 'notifications', kind: 'list' };
      case 'messages':
        return { defId: 'messages', kind: 'list' };
      case 'lists':
        return { defId: 'bookmarks', kind: 'list' };
      case 'tribes':
        return { defId: 'tribes', kind: 'list' };
      case 'follow-list':
        return { defId: 'follows', kind: 'list' };
      case 'media':
        return { defId: 'media', kind: 'list' };
      case 'muted':
        return { defId: 'muted', kind: 'list' };
      case 'marketplace':
        return { defId: 'marketplace', kind: 'list' };
      case 'profile':
        return { defId: 'profile', kind: 'list' };
      case 'search':
        // The Search object (v2): its own circle in the SV.
        return { defId: 'search', kind: 'list' };
      case 'my-listings':
        // '/my-listings' is the marketplace dashboard (detail of the
        // marketplace object — the surface swaps the manager view in).
        return { defId: 'marketplace', kind: 'detail', param: 'my-listings' };
      default:
        return null;
    }
  }

  return null;
}

/** Resolve a shared detail route to a domain: prefer the active object. */
function resolveShared(key: string, activeDefId?: string | null): string {
  const owners = SHARED_DETAIL_ROUTES[key] ?? [];
  if (activeDefId && owners.includes(activeDefId)) return activeDefId;
  return owners[0] ?? 'social';
}
