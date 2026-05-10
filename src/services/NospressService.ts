/**
 * NospressService
 * CRUD for NosPress page content.
 *
 * Multi-page (since slice 4.8/Slice 1):
 *  - Drafts and published mirrors are stored as Record<slug, NospressPageV2>
 *    in PerAccountLocalStorage. Slug '' = home page.
 *  - Legacy single-key stores (NOSPRESS_DRAFT_V2 / NOSPRESS_PUBLISHED_V2)
 *    are read as a one-time fallback for the home slug only, then migrated
 *    into the slug-keyed map on the next save.
 *
 * Relay events (NIP-78 kind:30078):
 *  - Home (slug==='')   → d-tag "noornote/list"  (legacy, backwards-compat)
 *  - Other slugs        → d-tag "noornote/page/<slug>"
 *  - Page-index         → d-tag "noornote/page-index" (separate orchestrator)
 *
 * @purpose Manage NosPress page content per account, per slug
 * @used-by NospressView, AutoSyncService
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';
import { NospressMountsService } from './NospressMountsService';
import { migrateV1ToV2 } from '../addons/nospress/blocks/migrate';
import { HOME_SLUG } from '../addons/nospress/blocks/pageIndex';
import { normalizePage } from '../addons/nospress/blocks/types';
import type { NospressPageV2 } from '../addons/nospress/blocks/types';

export interface NospressListSection {
  title: string;
  items: string[];
}

export interface NospressListData {
  version: 1;
  title?: string;
  subtitle?: string;
  description?: string;
  sections: NospressListSection[];
}

const EMPTY_LIST: NospressListData = { version: 1, sections: [] };

export function nospressHasContent(data: NospressListData | null): boolean {
  if (!data) return false;
  if (data.title?.trim()) return true;
  if (data.subtitle?.trim()) return true;
  if (data.description?.trim()) return true;
  return data.sections.length > 0;
}

type SlugMap<T> = Record<string, T>;

export class NospressService {
  private static instance: NospressService | null = null;
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): NospressService {
    if (!NospressService.instance) {
      NospressService.instance = new NospressService();
    }
    return NospressService.instance;
  }

  /**
   * Release the singleton so a subsequent getInstance() returns a fresh
   * object. Used by NospressRuntime.destroy() on addon toggle-OFF, logout,
   * or account switch. NEVER calls clear() — clear() is a destructive
   * persistent-data operation, not in-memory teardown.
   */
  public destroy(): void {
    NospressService.instance = null;
  }

  // ── v1 list (legacy, home only) ─────────────────────────────────────

  public getList(): NospressListData {
    return PerAccountLocalStorage.getInstance().get<NospressListData>(
      StorageKeys.NOSPRESS_LIST,
      EMPTY_LIST
    );
  }

  public saveList(data: NospressListData): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_LIST, data);
    this.eventBus.emit('nospressList:changed', { sections: data.sections });
  }

  public setListFromRelay(data: NospressListData): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_LIST, data);
  }

  public hasList(): boolean {
    return this.getList().sections.length > 0;
  }

  /**
   * Returns the home page in v2 format, migrated on-demand from v1
   * + the separate NOSPRESS_MOUNTS storage. Non-home slugs never have a
   * v1 fallback — they only exist as v2.
   */
  public getPageV2(slug: string = HOME_SLUG): NospressPageV2 {
    if (slug !== HOME_SLUG) {
      return { version: 2, blocks: [] };
    }
    const v1 = this.getList();
    const mounts = NospressMountsService.getInstance().getMounts();
    return normalizePage(migrateV1ToV2(v1, mounts));
  }

  // ── v2 drafts (per slug) ────────────────────────────────────────────

  public getDraftV2(slug: string = HOME_SLUG): NospressPageV2 | null {
    const map = this.readDraftMap();
    if (slug in map) {
      const draft = map[slug];
      return draft ? normalizePage(draft) : null;
    }
    if (slug === HOME_SLUG) {
      // Legacy fallback: old single-key store. Migrate lazily on next save.
      const legacy = PerAccountLocalStorage.getInstance().get<NospressPageV2 | null>(
        StorageKeys.NOSPRESS_DRAFT_V2,
        null
      );
      return legacy ? normalizePage(legacy) : null;
    }
    return null;
  }

  public saveDraftV2(page: NospressPageV2, opts?: { silent?: boolean; slug?: string }): void {
    const slug = opts?.slug ?? HOME_SLUG;
    const map = this.readDraftMap();
    map[slug] = page;
    this.writeDraftMap(map);
    if (slug === HOME_SLUG) {
      PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_DRAFT_V2);
    }
    if (!opts?.silent) {
      this.eventBus.emit('nospressDraftV2:changed', { page, slug });
    }
  }

  public clearDraftV2(slug: string = HOME_SLUG): void {
    const map = this.readDraftMap();
    delete map[slug];
    this.writeDraftMap(map);
    if (slug === HOME_SLUG) {
      PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_DRAFT_V2);
    }
    this.eventBus.emit('nospressDraftV2:changed', { page: null, slug });
  }

  public hasDraftV2(slug: string = HOME_SLUG): boolean {
    return this.getDraftV2(slug) !== null;
  }

  // ── v2 published mirrors (per slug) ─────────────────────────────────

  public getPublishedV2(slug: string = HOME_SLUG): NospressPageV2 | null {
    const map = this.readPublishedMap();
    if (slug in map) {
      const pub = map[slug];
      return pub ? normalizePage(pub) : null;
    }
    if (slug === HOME_SLUG) {
      const legacy = PerAccountLocalStorage.getInstance().get<NospressPageV2 | null>(
        StorageKeys.NOSPRESS_PUBLISHED_V2,
        null
      );
      return legacy ? normalizePage(legacy) : null;
    }
    return null;
  }

  public savePublishedV2(page: NospressPageV2, slug: string = HOME_SLUG): void {
    const map = this.readPublishedMap();
    map[slug] = page;
    this.writePublishedMap(map);
    if (slug === HOME_SLUG) {
      PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_PUBLISHED_V2);
    }
  }

  public clearPublishedV2(slug: string = HOME_SLUG): void {
    const map = this.readPublishedMap();
    delete map[slug];
    this.writePublishedMap(map);
    if (slug === HOME_SLUG) {
      PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_PUBLISHED_V2);
    }
  }

  /**
   * True if the user has any v2 content for the given slug — saved draft or
   * published mirror. Used by NospressView to decide between editable and
   * empty-shell renders.
   */
  public hasV2Content(slug: string = HOME_SLUG): boolean {
    const draft = this.getDraftV2(slug);
    if (draft && draft.blocks.length > 0) return true;
    const published = this.getPublishedV2(slug);
    if (published && published.blocks.length > 0) return true;
    return false;
  }

  // ── delete + global clear ───────────────────────────────────────────

  public deleteList(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_LIST);
    this.eventBus.emit('nospressList:changed', { sections: [] });
  }

  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_LIST);
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_DRAFT_V2);
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_PUBLISHED_V2);
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_DRAFTS_BY_SLUG);
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_PUBLISHED_BY_SLUG);
  }

  // ── private slug-map helpers ────────────────────────────────────────

  private readDraftMap(): SlugMap<NospressPageV2> {
    return PerAccountLocalStorage.getInstance().get<SlugMap<NospressPageV2>>(
      StorageKeys.NOSPRESS_DRAFTS_BY_SLUG,
      {}
    );
  }

  private writeDraftMap(map: SlugMap<NospressPageV2>): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_DRAFTS_BY_SLUG, map);
  }

  private readPublishedMap(): SlugMap<NospressPageV2> {
    return PerAccountLocalStorage.getInstance().get<SlugMap<NospressPageV2>>(
      StorageKeys.NOSPRESS_PUBLISHED_BY_SLUG,
      {}
    );
  }

  private writePublishedMap(map: SlugMap<NospressPageV2>): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_PUBLISHED_BY_SLUG, map);
  }
}
