/**
 * NostrInListService
 * CRUD for professional list data (NostrIn addon)
 *
 * Stores freetext sections with items in PerAccountLocalStorage.
 * Published to relays as NIP-78 kind:30078 with d-tag "noornote/list".
 *
 * @purpose Manage professional list data per account
 * @used-by NostrInListView, NostrInListEditorView, AutoSyncService
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';

export interface NostrInListSection {
  title: string;
  items: string[];
}

export interface NostrInListData {
  version: 1;
  sections: NostrInListSection[];
}

const EMPTY_LIST: NostrInListData = { version: 1, sections: [] };

export class NostrInListService {
  private static instance: NostrInListService;
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): NostrInListService {
    if (!NostrInListService.instance) {
      NostrInListService.instance = new NostrInListService();
    }
    return NostrInListService.instance;
  }

  public getList(): NostrInListData {
    return PerAccountLocalStorage.getInstance().get<NostrInListData>(
      StorageKeys.NOSTRIN_LIST,
      EMPTY_LIST
    );
  }

  public saveList(data: NostrInListData): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTRIN_LIST, data);
    this.eventBus.emit('nostrinList:changed', { sections: data.sections });
  }

  public setListFromRelay(data: NostrInListData): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTRIN_LIST, data);
  }

  public hasList(): boolean {
    const data = this.getList();
    return data.sections.length > 0;
  }

  public deleteList(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSTRIN_LIST);
    this.eventBus.emit('nostrinList:changed', { sections: [] });
  }

  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSTRIN_LIST);
  }
}
