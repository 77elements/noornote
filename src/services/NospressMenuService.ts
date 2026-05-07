/**
 * NospressMenuService
 * Per-account CRUD for NosPress site menus (Primary Navigation, etc.).
 *
 * The menu set persists locally. Auto-sync with the page index is the
 * caller's responsibility — call `syncWithPages()` whenever pages change so
 * Primary Navigation reflects the current page set without overriding the
 * user's manual ordering.
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';
import { NospressPageIndexService } from './NospressPageIndexService';
import {
  buildPrimaryMenuFromPages,
  reconcileMenuWithPages,
  PRIMARY_MENU_ID,
  PRIMARY_MENU_NAME,
  type NavItem,
  type NospressMenu,
  type NospressMenuSet,
} from '../addons/nospress/blocks/menu';

export class NospressMenuService {
  private static instance: NospressMenuService | null = null;
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): NospressMenuService {
    if (!NospressMenuService.instance) {
      NospressMenuService.instance = new NospressMenuService();
    }
    return NospressMenuService.instance;
  }

  /** Release the singleton. See NospressService.destroy() for rationale. */
  public destroy(): void {
    NospressMenuService.instance = null;
  }

  /**
   * Read the current menu set. If none is stored yet, seed Primary
   * Navigation with the current page index so the user always has a
   * working starting point. The seed is NOT persisted — the first
   * mutation (or explicit save) writes it.
   */
  public getMenuSet(): NospressMenuSet {
    const stored = PerAccountLocalStorage.getInstance().get<NospressMenuSet | null>(
      StorageKeys.NOSPRESS_MENUS,
      null
    );
    if (stored && stored.menus.length > 0) return stored;

    const pages = NospressPageIndexService.getInstance().getIndex().pages;
    return { version: 1, menus: [buildPrimaryMenuFromPages(pages)] };
  }

  public saveMenuSet(set: NospressMenuSet, opts?: { silent?: boolean }): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_MENUS, set);
    if (!opts?.silent) {
      this.eventBus.emit('nospressMenus:changed', { set });
    }
  }

  public setMenuSetFromRelay(set: NospressMenuSet): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_MENUS, set);
  }

  public hasMenuSet(): boolean {
    return PerAccountLocalStorage.getInstance().get<NospressMenuSet | null>(
      StorageKeys.NOSPRESS_MENUS,
      null
    ) !== null;
  }

  public getPrimaryMenu(): NospressMenu {
    const set = this.getMenuSet();
    const primary = set.menus.find(m => m.id === PRIMARY_MENU_ID);
    if (primary) return primary;
    const pages = NospressPageIndexService.getInstance().getIndex().pages;
    return buildPrimaryMenuFromPages(pages);
  }

  public getMenu(id: string): NospressMenu | null {
    return this.getMenuSet().menus.find(m => m.id === id) ?? null;
  }

  public updateMenu(id: string, updater: (menu: NospressMenu) => NospressMenu): void {
    const set = this.getMenuSet();
    const idx = set.menus.findIndex(m => m.id === id);
    if (idx < 0) throw new Error(`Menu not found: ${id}`);
    set.menus[idx] = updater(set.menus[idx]!);
    this.saveMenuSet(set);
  }

  /** Move a menu item up or down by one slot. No-op at boundaries. */
  public moveMenuItem(menuId: string, fromIndex: number, toIndex: number): void {
    this.updateMenu(menuId, menu => {
      if (fromIndex < 0 || fromIndex >= menu.items.length) return menu;
      if (toIndex < 0 || toIndex >= menu.items.length) return menu;
      if (fromIndex === toIndex) return menu;
      const items = [...menu.items];
      const [moved] = items.splice(fromIndex, 1);
      if (!moved) return menu;
      items.splice(toIndex, 0, moved);
      return { ...menu, items };
    });
  }

  public removeMenuItem(menuId: string, index: number): void {
    this.updateMenu(menuId, menu => {
      if (index < 0 || index >= menu.items.length) return menu;
      const items = [...menu.items];
      items.splice(index, 1);
      return { ...menu, items };
    });
  }

  public appendMenuItem(menuId: string, item: NavItem): void {
    this.updateMenu(menuId, menu => ({ ...menu, items: [...menu.items, item] }));
  }

  /**
   * Reconcile every menu's items with the current page index — drop items
   * pointing to deleted pages, append new pages to the end. User-set order
   * for existing items is preserved. Idempotent — no event emit when no
   * changes were made.
   */
  public syncWithPages(): void {
    const set = this.getMenuSet();
    const pages = NospressPageIndexService.getInstance().getIndex().pages;
    let changed = false;
    const next: NospressMenu[] = set.menus.map(menu => {
      const reconciled = reconcileMenuWithPages(menu, pages);
      if (
        reconciled.items.length !== menu.items.length ||
        reconciled.items.some((it, i) => {
          const prev = menu.items[i];
          return !prev || prev.type !== it.type || (prev.type === 'page' && it.type === 'page' && prev.pageSlug !== it.pageSlug);
        })
      ) {
        changed = true;
      }
      return reconciled;
    });
    if (changed) {
      this.saveMenuSet({ version: 1, menus: next });
    } else if (!this.hasMenuSet()) {
      // First-time seed (set was synthetic). Persist so subsequent reads
      // are stable and the user doesn't see Primary Navigation re-derive
      // from page-index after a manual reorder.
      this.saveMenuSet(set, { silent: true });
    }
  }

  /** Insert a new empty menu (for Slice 2.4 add-menu flow). Throws on id
   *  collision. */
  public addMenu(menu: NospressMenu): void {
    const set = this.getMenuSet();
    if (set.menus.some(m => m.id === menu.id)) {
      throw new Error(`Menu id already exists: ${menu.id}`);
    }
    set.menus.push(menu);
    this.saveMenuSet(set);
  }

  public removeMenu(id: string): void {
    if (id === PRIMARY_MENU_ID) {
      throw new Error('Primary Navigation cannot be removed');
    }
    const set = this.getMenuSet();
    set.menus = set.menus.filter(m => m.id !== id);
    this.saveMenuSet(set);
  }

  public renameMenu(id: string, name: string): void {
    this.updateMenu(id, menu => ({ ...menu, name }));
  }

  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_MENUS);
  }

  /** Re-export so callers don't need to know about the impl module. */
  public getPrimaryName(): string {
    return PRIMARY_MENU_NAME;
  }
}
