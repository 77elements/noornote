/**
 * NospressMountsService
 * Manages bookmark folders mounted to the NosPress subpage (/profile/:npub/page)
 *
 * Sister service to ProfileMountsService — independent state, independent
 * publish target on relays. The "Profile"-checkbox on a Bookmark folder
 * mounts via ProfileMountsService → PV inline. The "NosPress"-checkbox mounts
 * via this service → /page subpage.
 *
 * @purpose Manage which bookmark folders are listed on the NosPress subpage
 * @used-by BookmarkSecondaryManager (checkbox), NospressView (display)
 */

import { EventBus } from './EventBus';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

interface NospressMountData {
  folderName: string;
  mountedAt: number;
}

interface NospressMountsStorage {
  version: 1;
  mounts: NospressMountData[];
}

const MAX_MOUNTS = 15;

export class NospressMountsService {
  private static instance: NospressMountsService | null = null;
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): NospressMountsService {
    if (!NospressMountsService.instance) {
      NospressMountsService.instance = new NospressMountsService();
    }
    return NospressMountsService.instance;
  }

  /** Release the singleton. See NospressService.destroy() for rationale. */
  public destroy(): void {
    NospressMountsService.instance = null;
  }

  public getMounts(): string[] {
    const data = this.loadFromStorage();
    return data.mounts.map(m => m.folderName);
  }

  public getMountsWithData(): NospressMountData[] {
    const data = this.loadFromStorage();
    return data.mounts;
  }

  public isMounted(folderName: string): boolean {
    const data = this.loadFromStorage();
    return data.mounts.some(m => m.folderName === folderName);
  }

  public addMount(folderName: string): boolean {
    const data = this.loadFromStorage();

    if (data.mounts.some(m => m.folderName === folderName)) {
      return false;
    }

    if (data.mounts.length >= MAX_MOUNTS) {
      return false;
    }

    data.mounts.push({
      folderName,
      mountedAt: Date.now()
    });

    this.saveToStorage(data);
    this.eventBus.emit('nospressMounts:changed', { mounts: this.getMounts() });
    return true;
  }

  public removeMount(folderName: string): void {
    const data = this.loadFromStorage();
    data.mounts = data.mounts.filter(m => m.folderName !== folderName);
    this.saveToStorage(data);
    this.eventBus.emit('nospressMounts:changed', { mounts: this.getMounts() });
  }

  public toggleMount(folderName: string): { mounted: boolean; error?: string } {
    if (this.isMounted(folderName)) {
      this.removeMount(folderName);
      return { mounted: false };
    } else {
      if (this.getMounts().length >= MAX_MOUNTS) {
        return {
          mounted: false,
          error: `Maximum ${MAX_MOUNTS} folders on NosPress reached. Unmount one before adding another.`
        };
      }
      this.addMount(folderName);
      return { mounted: true };
    }
  }

  public reorderMounts(newOrder: string[]): void {
    const data = this.loadFromStorage();
    const mountMap = new Map(data.mounts.map(m => [m.folderName, m]));

    const reordered: NospressMountData[] = [];
    for (const folderName of newOrder) {
      const existing = mountMap.get(folderName);
      if (existing) {
        reordered.push(existing);
      }
    }

    data.mounts = reordered;
    this.saveToStorage(data);
    this.eventBus.emit('nospressMounts:changed', { mounts: this.getMounts() });
  }

  public getMountCount(): number {
    return this.loadFromStorage().mounts.length;
  }

  public isLimitReached(): boolean {
    return this.getMountCount() >= MAX_MOUNTS;
  }

  public setMountsFromRelay(folderNames: string[]): void {
    const data: NospressMountsStorage = {
      version: 1,
      mounts: folderNames.map((name, index) => ({
        folderName: name,
        mountedAt: Date.now() - (folderNames.length - index)
      }))
    };
    this.saveToStorage(data);
    this.eventBus.emit('nospressMounts:changed', { mounts: this.getMounts() });
  }

  public handleFolderRename(oldName: string, newName: string): void {
    const data = this.loadFromStorage();
    const mount = data.mounts.find(m => m.folderName === oldName);
    if (mount) {
      mount.folderName = newName;
      this.saveToStorage(data);
      this.eventBus.emit('nospressMounts:changed', { mounts: this.getMounts() });
    }
  }

  public handleFolderDelete(folderName: string): void {
    this.removeMount(folderName);
  }

  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_MOUNTS);
  }

  private loadFromStorage(): NospressMountsStorage {
    return PerAccountLocalStorage.getInstance().get<NospressMountsStorage>(
      StorageKeys.NOSPRESS_MOUNTS,
      { version: 1, mounts: [] }
    );
  }

  private saveToStorage(data: NospressMountsStorage): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_MOUNTS, data);
  }
}
