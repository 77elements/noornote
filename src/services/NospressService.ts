/**
 * NospressService
 * CRUD for NosPress custom list data
 *
 * Stores freetext sections with items in PerAccountLocalStorage.
 * Published to relays as NIP-78 kind:30078 with d-tag "noornote/list".
 *
 * @purpose Manage NosPress custom list data per account
 * @used-by NospressView, AutoSyncService
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';
import { NospressMountsService } from './NospressMountsService';
import { migrateV1ToV2 } from '../addons/nospress/blocks/migrate';
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

export class NospressService {
  private static instance: NospressService;
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
    const data = this.getList();
    return data.sections.length > 0;
  }

  /**
   * Returns the page in v2 (block-based) format, migrated on-demand from v1
   * + the separate NOSPRESS_MOUNTS storage. The canonical write format remains
   * v1 until the editor is rewritten to produce v2 directly.
   */
  public getPageV2(): NospressPageV2 {
    const v1 = this.getList();
    const mounts = NospressMountsService.getInstance().getMounts();
    return migrateV1ToV2(v1, mounts);
  }

  /**
   * v2 draft (work-in-progress). Persisted locally only — NOT published to
   * relays. Used by the new Block Editor in the SCC tab during Phase 4. Once
   * the user publishes, the draft is the source for the relay event.
   *
   * If a draft exists, NospressView renders it instead of v1. If no draft
   * exists, NospressView migrates v1 → v2 on read for rendering.
   */
  public getDraftV2(): NospressPageV2 | null {
    return PerAccountLocalStorage.getInstance().get<NospressPageV2 | null>(
      StorageKeys.NOSPRESS_DRAFT_V2,
      null
    );
  }

  public saveDraftV2(page: NospressPageV2, opts?: { silent?: boolean }): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_DRAFT_V2, page);
    if (!opts?.silent) {
      this.eventBus.emit('nospressDraftV2:changed', { page });
    }
  }

  public clearDraftV2(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_DRAFT_V2);
    this.eventBus.emit('nospressDraftV2:changed', { page: null });
  }

  public hasDraftV2(): boolean {
    return this.getDraftV2() !== null;
  }

  /**
   * True if the user has any v2 content — saved draft or published mirror.
   * Used by NospressView to decide between the editable page render and
   * the empty/shell render when the v1 list is empty but a v2 page exists.
   */
  public hasV2Content(): boolean {
    const draft = this.getDraftV2();
    if (draft && draft.blocks.length > 0) return true;
    const published = this.getPublishedV2();
    if (published && published.blocks.length > 0) return true;
    return false;
  }

  /**
   * Last-published v2 page (mirror of the relay event content). Stored
   * locally so NospressView can render the v2 content immediately after
   * publish without waiting for a relay round-trip — and so a returning
   * user sees the published v2 even if their v1 storage is stale.
   */
  public getPublishedV2(): NospressPageV2 | null {
    return PerAccountLocalStorage.getInstance().get<NospressPageV2 | null>(
      StorageKeys.NOSPRESS_PUBLISHED_V2,
      null
    );
  }

  public savePublishedV2(page: NospressPageV2): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_PUBLISHED_V2, page);
  }

  public clearPublishedV2(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_PUBLISHED_V2);
  }

  public deleteList(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_LIST);
    this.eventBus.emit('nospressList:changed', { sections: [] });
  }

  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_LIST);
  }
}
