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

export interface MypageListSection {
  title: string;
  items: string[];
}

export interface MypageListData {
  version: 1;
  sections: MypageListSection[];
}

const EMPTY_LIST: MypageListData = { version: 1, sections: [] };

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

  public deleteList(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.MYPAGE_LIST);
    this.eventBus.emit('mypageList:changed', { sections: [] });
  }

  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.MYPAGE_LIST);
  }
}
