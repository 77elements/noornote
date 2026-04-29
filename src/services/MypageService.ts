/**
 * MypageService
 * CRUD for My Page custom list data
 *
 * Stores freetext sections with items in PerAccountLocalStorage.
 * Published to relays as NIP-78 kind:30078 with d-tag "noornote/list".
 *
 * @purpose Manage My Page custom list data per account
 * @used-by MypageView, MypageEditorView, AutoSyncService
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';
import { MyPageMountsService } from './MyPageMountsService';
import { migrateV1ToV2 } from '../addons/mypage/blocks/migrate';
import type { MypagePageV2 } from '../addons/mypage/blocks/types';

export interface MypageListSection {
  title: string;
  items: string[];
}

export interface MypageListData {
  version: 1;
  title?: string;
  subtitle?: string;
  description?: string;
  sections: MypageListSection[];
}

const EMPTY_LIST: MypageListData = { version: 1, sections: [] };

export function mypageHasContent(data: MypageListData | null): boolean {
  if (!data) return false;
  if (data.title?.trim()) return true;
  if (data.subtitle?.trim()) return true;
  if (data.description?.trim()) return true;
  return data.sections.length > 0;
}

export class MypageService {
  private static instance: MypageService;
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): MypageService {
    if (!MypageService.instance) {
      MypageService.instance = new MypageService();
    }
    return MypageService.instance;
  }

  public getList(): MypageListData {
    return PerAccountLocalStorage.getInstance().get<MypageListData>(
      StorageKeys.MYPAGE_LIST,
      EMPTY_LIST
    );
  }

  public saveList(data: MypageListData): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.MYPAGE_LIST, data);
    this.eventBus.emit('mypageList:changed', { sections: data.sections });
  }

  public setListFromRelay(data: MypageListData): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.MYPAGE_LIST, data);
  }

  public hasList(): boolean {
    const data = this.getList();
    return data.sections.length > 0;
  }

  /**
   * Returns the page in v2 (block-based) format, migrated on-demand from v1
   * + the separate MYPAGE_MOUNTS storage. The canonical write format remains
   * v1 until the editor is rewritten to produce v2 directly.
   */
  public getPageV2(): MypagePageV2 {
    const v1 = this.getList();
    const mounts = MyPageMountsService.getInstance().getMounts();
    return migrateV1ToV2(v1, mounts);
  }

  /**
   * v2 draft (work-in-progress). Persisted locally only — NOT published to
   * relays. Used by the new Block Editor in the SCC tab during Phase 4. Once
   * the user publishes, the draft is the source for the relay event.
   *
   * If a draft exists, MypageView renders it instead of v1. If no draft
   * exists, MypageView migrates v1 → v2 on read for rendering.
   */
  public getDraftV2(): MypagePageV2 | null {
    return PerAccountLocalStorage.getInstance().get<MypagePageV2 | null>(
      StorageKeys.MYPAGE_DRAFT_V2,
      null
    );
  }

  public saveDraftV2(page: MypagePageV2, opts?: { silent?: boolean }): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.MYPAGE_DRAFT_V2, page);
    if (!opts?.silent) {
      this.eventBus.emit('mypageDraftV2:changed', { page });
    }
  }

  public clearDraftV2(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.MYPAGE_DRAFT_V2);
    this.eventBus.emit('mypageDraftV2:changed', { page: null });
  }

  public hasDraftV2(): boolean {
    return this.getDraftV2() !== null;
  }

  /**
   * Last-published v2 page (mirror of the relay event content). Stored
   * locally so MypageView can render the v2 content immediately after
   * publish without waiting for a relay round-trip — and so a returning
   * user sees the published v2 even if their v1 storage is stale.
   */
  public getPublishedV2(): MypagePageV2 | null {
    return PerAccountLocalStorage.getInstance().get<MypagePageV2 | null>(
      StorageKeys.MYPAGE_PUBLISHED_V2,
      null
    );
  }

  public savePublishedV2(page: MypagePageV2): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.MYPAGE_PUBLISHED_V2, page);
  }

  public clearPublishedV2(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.MYPAGE_PUBLISHED_V2);
  }

  public deleteList(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.MYPAGE_LIST);
    this.eventBus.emit('mypageList:changed', { sections: [] });
  }

  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.MYPAGE_LIST);
  }
}
