/**
 * NospressPageIndexService
 * Per-account CRUD for the NosPress multi-page index.
 *
 * The index is the source of truth for which pages exist and in what order.
 * Page content lives in separate NIP-78 events (one per slug), addressed
 * via NospressService + NospressOrchestrator.
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';
import {
  DEFAULT_PAGE_INDEX,
  HOME_SLUG,
  isValidSlug,
  type NospressPageIndex,
  type PageIndexEntry,
} from '../addons/nospress/blocks/pageIndex';

export class NospressPageIndexService {
  private static instance: NospressPageIndexService | null = null;
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): NospressPageIndexService {
    if (!NospressPageIndexService.instance) {
      NospressPageIndexService.instance = new NospressPageIndexService();
    }
    return NospressPageIndexService.instance;
  }

  /** Release the singleton. See NospressService.destroy() for rationale. */
  public destroy(): void {
    NospressPageIndexService.instance = null;
  }

  public getIndex(): NospressPageIndex {
    const stored = PerAccountLocalStorage.getInstance().get<NospressPageIndex | null>(
      StorageKeys.NOSPRESS_PAGE_INDEX,
      null
    );
    if (stored && Array.isArray(stored.pages) && stored.pages.length > 0) return stored;
    return { version: 1, pages: [...DEFAULT_PAGE_INDEX.pages] };
  }

  public saveIndex(index: NospressPageIndex, opts?: { silent?: boolean }): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_PAGE_INDEX, index);
    if (!opts?.silent) {
      this.eventBus.emit('nospressPageIndex:changed', { index });
    }
  }

  public setIndexFromRelay(index: NospressPageIndex): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_PAGE_INDEX, index);
  }

  public hasIndex(): boolean {
    return PerAccountLocalStorage.getInstance().get<NospressPageIndex | null>(
      StorageKeys.NOSPRESS_PAGE_INDEX,
      null
    ) !== null;
  }

  public getEntry(slug: string): PageIndexEntry | null {
    return this.getIndex().pages.find(p => p.slug === slug) ?? null;
  }

  public hasSlug(slug: string): boolean {
    return this.getEntry(slug) !== null;
  }

  /**
   * Add a new page to the index. Slug must be valid + unique. Home slug
   * (empty string) auto-exists in the default index, so callers don't need
   * to seed it.
   */
  public addPage(entry: PageIndexEntry): void {
    if (!isValidSlug(entry.slug)) throw new Error(`Invalid slug: ${entry.slug}`);
    const index = this.getIndex();
    if (index.pages.some(p => p.slug === entry.slug)) {
      throw new Error(`Slug already exists: ${entry.slug}`);
    }
    index.pages.push({ slug: entry.slug, title: entry.title });
    this.saveIndex(index);
  }

  public renamePage(slug: string, newTitle: string): void {
    const index = this.getIndex();
    const page = index.pages.find(p => p.slug === slug);
    if (!page) throw new Error(`Slug not found: ${slug}`);
    page.title = newTitle;
    this.saveIndex(index);
  }

  /** Remove a page from the index. Home slug ('') cannot be removed. */
  public removePage(slug: string): void {
    if (slug === HOME_SLUG) throw new Error('Cannot remove the home page');
    const index = this.getIndex();
    index.pages = index.pages.filter(p => p.slug !== slug);
    this.saveIndex(index);
  }

  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_PAGE_INDEX);
  }
}
