/**
 * Multi-menu data model for NosPress sites.
 *
 * A user can define multiple named menus (Primary Navigation, Footer Menu,
 * etc.). Each menu is an ordered list of items. In Slice 2.2 only page
 * items exist — Slice 2.4 adds external URL items.
 *
 * Primary Navigation is special:
 *  - id `'primary'` is reserved
 *  - exists from the start (auto-created with all current page slugs when
 *    the menu set is empty)
 *  - new pages are auto-appended; deleted pages are auto-removed
 *  - user can still reorder freely; the auto-sync only adds/removes, never
 *    touches existing order
 *
 * NIP-78: kind:30078, d-tag `noornote/menus`, content = `NospressMenuSet`.
 */

import type { PageIndexEntry } from './pageIndex';

export type NavItem =
  | { type: 'page'; pageSlug: string }
  | { type: 'url'; label: string; url: string };

export interface NospressMenu {
  id: string;
  name: string;
  items: NavItem[];
}

export interface NospressMenuSet {
  version: 1;
  menus: NospressMenu[];
}

export const PRIMARY_MENU_ID = 'primary';
export const PRIMARY_MENU_NAME = 'Primary Navigation';

export function isMenuSet(data: unknown): data is NospressMenuSet {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { version?: unknown; menus?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.menus)) return false;
  return obj.menus.every(m => isMenu(m));
}

function isMenu(data: unknown): data is NospressMenu {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { id?: unknown; name?: unknown; items?: unknown };
  if (typeof obj.id !== 'string' || typeof obj.name !== 'string') return false;
  if (!Array.isArray(obj.items)) return false;
  return obj.items.every(i => isNavItem(i));
}

function isNavItem(data: unknown): data is NavItem {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { type?: unknown; pageSlug?: unknown; label?: unknown; url?: unknown };
  if (obj.type === 'page') return typeof obj.pageSlug === 'string';
  if (obj.type === 'url') return typeof obj.label === 'string' && typeof obj.url === 'string';
  return false;
}

/** Build a fresh primary menu from a page index. Pages keep their index
 *  order on initial creation. */
export function buildPrimaryMenuFromPages(pages: PageIndexEntry[]): NospressMenu {
  return {
    id: PRIMARY_MENU_ID,
    name: PRIMARY_MENU_NAME,
    items: pages.map(p => ({ type: 'page', pageSlug: p.slug })),
  };
}

/** Reconcile a menu's items with the current page set:
 *   - drop page items pointing to slugs that no longer exist
 *   - keep URL items untouched (no auto-sync semantics for those)
 *   - append new pages to the end (preserving user's existing order)
 *  Returns a new menu (caller decides whether to save). */
export function reconcileMenuWithPages(menu: NospressMenu, pages: PageIndexEntry[]): NospressMenu {
  const validSlugs = new Set(pages.map(p => p.slug));
  const present = new Set<string>();
  const kept: NavItem[] = [];

  for (const item of menu.items) {
    if (item.type === 'url') {
      kept.push(item);
      continue;
    }
    if (validSlugs.has(item.pageSlug)) {
      kept.push(item);
      present.add(item.pageSlug);
    }
  }

  // Auto-append new pages ONLY for Primary Navigation. Other menus
  // (Footer Menu, secondary nav, etc.) are user-curated — adding a new
  // page should not spam every menu the user happens to have created.
  // Dropping deleted pages still happens for all menus (above).
  if (menu.id === PRIMARY_MENU_ID) {
    for (const page of pages) {
      if (!present.has(page.slug)) {
        kept.push({ type: 'page', pageSlug: page.slug });
      }
    }
  }

  return { ...menu, items: kept };
}
