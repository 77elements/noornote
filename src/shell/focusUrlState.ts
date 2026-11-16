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
      default:
        return null;
    }
  }

  // One-segment routes: the objects' list states.
  if (segments.length === 1) {
    switch (segments[0]) {
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
      case 'profile':
        return { defId: 'profile', kind: 'list' };
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
