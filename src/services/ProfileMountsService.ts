/**
 * ProfileMountsService
 * Manages profile-mounted bookmark folders in localStorage
 *
 * Profile mounts allow users to display bookmark folders on their profile page.
 * This is a NoorNote-specific feature using NIP-78 for relay storage.
 *
 * @purpose Manage which bookmark folders are mounted to the user's profile
 * @used-by BookmarkSecondaryManager (checkbox), ProfileView (display)
 */

import { EventBus } from './EventBus';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

interface ProfileMountData {
  folderName: string;  // Folder name (= d-tag of kind:30003)
  mountedAt: number;   // Timestamp when mounted (for default ordering)
}

interface ProfileMountsStorage {
  version: 1;
  mounts: ProfileMountData[];
}


const MAX_MOUNTS = 5;

export class ProfileMountsService {
  private static instance: ProfileMountsService;
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): ProfileMountsService {
    if (!ProfileMountsService.instance) {
      ProfileMountsService.instance = new ProfileMountsService();
    }
    return ProfileMountsService.instance;
  }

  /**
   * Get all mounted folder names (in order)
   */
  public getMounts(): string[] {
    const data = this.loadFromStorage();
    return data.mounts.map(m => m.folderName);
  }

  /**
   * Get mount data with timestamps (for ordering)
   */
  public getMountsWithData(): ProfileMountData[] {
    const data = this.loadFromStorage();
    return data.mounts;
  }

  /**
   * Check if a folder is mounted
   */
  public isMounted(folderName: string): boolean {
    const data = this.loadFromStorage();
    return data.mounts.some(m => m.folderName === folderName);
  }

  /**
   * Add a folder to profile mounts
   * @returns true if added, false if already mounted or limit reached
   */
  public addMount(folderName: string): boolean {
    const data = this.loadFromStorage();

    // Check if already mounted
    if (data.mounts.some(m => m.folderName === folderName)) {
      return false;
    }

    // Check limit
    if (data.mounts.length >= MAX_MOUNTS) {
      return false;
    }

    // Add with timestamp
    data.mounts.push({
      folderName,
      mountedAt: Date.now()
    });

    this.saveToStorage(data);
    this.eventBus.emit('profileMounts:changed', { mounts: this.getMounts() });
    return true;
  }

  /**
   * Remove a folder from profile mounts
   */
  public removeMount(folderName: string): void {
    const data = this.loadFromStorage();
    data.mounts = data.mounts.filter(m => m.folderName !== folderName);
    this.saveToStorage(data);
    this.eventBus.emit('profileMounts:changed', { mounts: this.getMounts() });
  }

  /**
   * Toggle mount status
   * @returns new mount status (true = mounted, false = unmounted)
   */
  public toggleMount(folderName: string): { mounted: boolean; error?: string } {
    if (this.isMounted(folderName)) {
      this.removeMount(folderName);
      return { mounted: false };
    } else {
      if (this.getMounts().length >= MAX_MOUNTS) {
        return {
          mounted: false,
          error: 'Maximale Anzahl mounts erreicht. Deselektiere, bevor du neue anhängen willst.'
        };
      }
      this.addMount(folderName);
      return { mounted: true };
    }
  }

  /**
   * Reorder mounts (for drag & drop in ProfileView)
   */
  public reorderMounts(newOrder: string[]): void {
    const data = this.loadFromStorage();
    const mountMap = new Map(data.mounts.map(m => [m.folderName, m]));

    // Build new order, preserving mountedAt timestamps
    const reordered: ProfileMountData[] = [];
    for (const folderName of newOrder) {
      const existing = mountMap.get(folderName);
      if (existing) {
        reordered.push(existing);
      }
    }

    data.mounts = reordered;
    this.saveToStorage(data);
    this.eventBus.emit('profileMounts:changed', { mounts: this.getMounts() });
  }

  /**
   * Get mount count
   */
  public getMountCount(): number {
    return this.loadFromStorage().mounts.length;
  }

  /**
   * Check if mount limit reached
   */
  public isLimitReached(): boolean {
    return this.getMountCount() >= MAX_MOUNTS;
  }

  /**
   * Set mounts from relay data (used by orchestrator)
   */
  public setMountsFromRelay(folderNames: string[]): void {
    const data: ProfileMountsStorage = {
      version: 1,
      mounts: folderNames.map((name, index) => ({
        folderName: name,
        mountedAt: Date.now() - (folderNames.length - index) // Preserve order
      }))
    };
    this.saveToStorage(data);
    this.eventBus.emit('profileMounts:changed', { mounts: this.getMounts() });
  }

  /**
   * Handle folder rename - update mount reference
   */
  public handleFolderRename(oldName: string, newName: string): void {
    const data = this.loadFromStorage();
    const mount = data.mounts.find(m => m.folderName === oldName);
    if (mount) {
      mount.folderName = newName;
      this.saveToStorage(data);
      this.eventBus.emit('profileMounts:changed', { mounts: this.getMounts() });
    }
  }

  /**
   * Handle folder deletion - remove mount
   */
  public handleFolderDelete(folderName: string): void {
    this.removeMount(folderName);
  }

  /**
   * Clear all mounts (for logout)
   */
  public clear(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.PROFILE_MOUNTS);
  }

  // ========================================
  // Private helpers
  // ========================================

  private loadFromStorage(): ProfileMountsStorage {
    return PerAccountLocalStorage.getInstance().get<ProfileMountsStorage>(
      StorageKeys.PROFILE_MOUNTS,
      { version: 1, mounts: [] }
    );
  }

  private saveToStorage(data: ProfileMountsStorage): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.PROFILE_MOUNTS, data);
  }
}
