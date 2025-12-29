/**
 * ProfileRecognitionService
 * Manages profile encounter tracking for followed users
 *
 * Features:
 * - Records first encounter (name + picture) when user follows someone
 * - Tracks metadata changes (lastKnown name + picture)
 * - Auto-saves to file (500ms debounce) and relays (5s debounce)
 * - Auto-loads on init: localStorage → file → relays (cascade)
 * - Cleanup on unfollow
 *
 * Architecture:
 * - Working storage: PerAccountLocalStorage (fast, synchronous)
 * - Persistent storage: ProfileEncounterFileStorage (Tauri file)
 * - Relay storage: ProfileRecognitionOrchestrator (NIP-78)
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { ProfileEncounterFileStorage, type ProfileEncounter } from './storage/ProfileEncounterFileStorage';
import { EventBus } from './EventBus';
import { SystemLogger } from '../components/system/SystemLogger';
import { FollowStorageAdapter } from './sync/adapters/FollowStorageAdapter';
import { UserProfileService } from './UserProfileService';
import { ProfileRecognitionOrchestrator } from './orchestration/ProfileRecognitionOrchestrator';
import { AuthService } from './AuthService';

const FILE_SAVE_DEBOUNCE = 500; // 500ms
const RELAY_SAVE_DEBOUNCE = 5000; // 5s

export class ProfileRecognitionService {
  private static instance: ProfileRecognitionService;
  private storage: PerAccountLocalStorage;
  private fileStorage: ProfileEncounterFileStorage;
  private orchestrator: ProfileRecognitionOrchestrator;
  private eventBus: EventBus;
  private systemLogger: SystemLogger;
  private followAdapter: FollowStorageAdapter;
  private userProfileService: UserProfileService;
  private authService: AuthService;

  // Debounce timers
  private fileSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  private relaySaveTimeout: ReturnType<typeof setTimeout> | null = null;

  // Initialization state
  private initialized = false;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
    this.fileStorage = ProfileEncounterFileStorage.getInstance();
    this.orchestrator = ProfileRecognitionOrchestrator.getInstance();
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.followAdapter = new FollowStorageAdapter();
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
  }

  public static getInstance(): ProfileRecognitionService {
    if (!ProfileRecognitionService.instance) {
      ProfileRecognitionService.instance = new ProfileRecognitionService();
    }
    return ProfileRecognitionService.instance;
  }

  /**
   * Initialize service - auto-load encounters
   * Cascade: localStorage → file → relays
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    this.systemLogger.info('ProfileRecognitionService', 'Initializing...');

    // Check localStorage first
    const localEncounters = this.getEncountersFromStorage();

    if (Object.keys(localEncounters).length > 0) {
      this.systemLogger.info('ProfileRecognitionService', `Loaded ${Object.keys(localEncounters).length} encounters from localStorage`);
      this.initialized = true;
      this.setupEventListeners();
      return;
    }

    // localStorage empty - try loading from file
    try {
      await this.fileStorage.initialize();
      const fileData = await this.fileStorage.read();

      if (Object.keys(fileData.encounters).length > 0) {
        this.systemLogger.info('ProfileRecognitionService', `Loaded ${Object.keys(fileData.encounters).length} encounters from file`);
        this.storage.set(StorageKeys.PROFILE_ENCOUNTERS, fileData.encounters);
        this.initialized = true;
        this.setupEventListeners();
        return;
      }
    } catch (error) {
      this.systemLogger.error('ProfileRecognitionService', `Failed to load from file: ${error}`);
    }

    // File also empty - try loading from relays
    const currentUser = this.authService.getCurrentUser();
    if (currentUser) {
      try {
        const relayData = await this.orchestrator.fetchFromRelays(
          currentUser.pubkey,
          true
        );

        if (relayData && Object.keys(relayData.encounters).length > 0) {
          this.systemLogger.info('ProfileRecognitionService', `Loaded ${Object.keys(relayData.encounters).length} encounters from relays`);
          this.storage.set(StorageKeys.PROFILE_ENCOUNTERS, relayData.encounters);
          // Also save to file for future loads
          await this.fileStorage.write(relayData);
          this.initialized = true;
          this.setupEventListeners();
          return;
        }
      } catch (error) {
        this.systemLogger.error('ProfileRecognitionService', `Failed to load from relays: ${error}`);
      }
    }

    this.systemLogger.info('ProfileRecognitionService', 'No encounters found, starting fresh');
    this.initialized = true;
    this.setupEventListeners();

    // Initial sync: capture encounters for any current follows that don't have one yet
    this.handleFollowListChange();
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for follow/unfollow events
    this.eventBus.on('follow:updated', () => {
      this.handleFollowListChange();
    });
  }

  /**
   * Handle follow list changes - detect new follows/unfollows
   */
  private async handleFollowListChange(): Promise<void> {
    const currentFollows = this.followAdapter.getBrowserItems();
    const currentPubkeys = new Set(currentFollows.map(f => f.pubkey));
    const storedEncounters = this.getEncountersFromStorage();
    const storedPubkeys = new Set(Object.keys(storedEncounters));

    // Detect new follows (in current but not in stored)
    for (const pubkey of currentPubkeys) {
      if (!storedPubkeys.has(pubkey)) {
        // New follow - record encounter
        await this.recordEncounterForPubkey(pubkey);
      }
    }

    // Detect unfollows (in stored but not in current)
    for (const pubkey of storedPubkeys) {
      if (!currentPubkeys.has(pubkey)) {
        // Unfollow - delete encounter
        this.deleteEncounter(pubkey);
      }
    }
  }

  /**
   * Record encounter for a specific pubkey (internal - fetches profile)
   */
  private async recordEncounterForPubkey(pubkey: string): Promise<void> {
    try {
      // Fetch current profile
      const profile = await this.userProfileService.getUserProfile(pubkey);
      const name = profile.display_name || profile.name || profile.username || 'Anon';
      const picture = profile.picture || '';

      this.recordEncounter(pubkey, name, picture);
      this.systemLogger.info('ProfileRecognitionService', `Recorded encounter for ${name.slice(0, 20)}`);
    } catch (error) {
      this.systemLogger.error('ProfileRecognitionService', `Failed to record encounter for ${pubkey.slice(0, 8)}: ${error}`);
    }
  }

  /**
   * Record first encounter for a followed user
   */
  public recordEncounter(pubkey: string, name: string, pictureUrl: string): void {
    const encounters = this.getEncountersFromStorage();

    // Don't overwrite existing encounter (first encounter is immutable)
    if (encounters[pubkey]) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    encounters[pubkey] = {
      firstName: name,
      firstPictureUrl: pictureUrl,
      firstSeenAt: now,
      lastKnownName: name,
      lastKnownPictureUrl: pictureUrl,
      lastChangedAt: now
    };

    this.storage.set(StorageKeys.PROFILE_ENCOUNTERS, encounters);
    this.scheduleAutoSave();
  }

  /**
   * Get encounter for a pubkey
   */
  public getEncounter(pubkey: string): ProfileEncounter | null {
    const encounters = this.getEncountersFromStorage();
    return encounters[pubkey] || null;
  }

  /**
   * Update last known metadata (when profile changes detected)
   */
  public updateLastKnown(pubkey: string, name: string, pictureUrl: string): void {
    const encounters = this.getEncountersFromStorage();
    const encounter = encounters[pubkey];

    if (!encounter) {
      // No encounter recorded yet - shouldn't happen, but handle gracefully
      return;
    }

    // Update only if actually changed
    if (encounter.lastKnownName === name && encounter.lastKnownPictureUrl === pictureUrl) {
      return;
    }

    encounter.lastKnownName = name;
    encounter.lastKnownPictureUrl = pictureUrl;
    encounter.lastChangedAt = Math.floor(Date.now() / 1000);

    this.storage.set(StorageKeys.PROFILE_ENCOUNTERS, encounters);
    this.scheduleAutoSave();
  }

  /**
   * Delete encounter (on unfollow)
   */
  public deleteEncounter(pubkey: string): void {
    const encounters = this.getEncountersFromStorage();

    if (!encounters[pubkey]) {
      return;
    }

    delete encounters[pubkey];
    this.storage.set(StorageKeys.PROFILE_ENCOUNTERS, encounters);
    this.scheduleAutoSave();
    this.systemLogger.info('ProfileRecognitionService', `Deleted encounter for ${pubkey.slice(0, 8)}`);
  }

  /**
   * Check if profile has changed within recognition window
   * Returns true if blinking should be active
   */
  public hasChangedWithinWindow(pubkey: string): boolean {
    const encounter = this.getEncounter(pubkey);
    if (!encounter) return false;

    // Check if metadata actually changed
    if (encounter.firstName === encounter.lastKnownName &&
        encounter.firstPictureUrl === encounter.lastKnownPictureUrl) {
      return false; // No change
    }

    // Get window setting from localStorage (global, not per-account)
    const windowDays = this.getRecognitionWindowDays();

    if (windowDays === 0) {
      return false; // Feature disabled
    }

    if (windowDays === -1) {
      return true; // Always show
    }

    // Check if within window
    const windowSeconds = windowDays * 24 * 60 * 60;
    const timeSinceChange = Math.floor(Date.now() / 1000) - encounter.lastChangedAt;

    return timeSinceChange < windowSeconds;
  }

  /**
   * Get recognition window in days from settings
   * Returns: 0 = disabled, -1 = always, or number of days
   */
  private getRecognitionWindowDays(): number {
    try {
      const setting = localStorage.getItem('noornote_profile_recognition_window');
      if (!setting) return 90; // Default: 90 days

      const value = parseInt(setting, 10);
      return isNaN(value) ? 90 : value;
    } catch {
      return 90;
    }
  }

  /**
   * Schedule auto-save to file and relays (debounced)
   */
  private scheduleAutoSave(): void {
    // Debounce file save (500ms)
    if (this.fileSaveTimeout) {
      clearTimeout(this.fileSaveTimeout);
    }
    this.fileSaveTimeout = setTimeout(() => {
      this.saveToFile();
    }, FILE_SAVE_DEBOUNCE);

    // Debounce relay save (5s)
    if (this.relaySaveTimeout) {
      clearTimeout(this.relaySaveTimeout);
    }
    this.relaySaveTimeout = setTimeout(() => {
      this.saveToRelays();
    }, RELAY_SAVE_DEBOUNCE);
  }

  /**
   * Save encounters to Tauri file
   */
  private async saveToFile(): Promise<void> {
    try {
      await this.fileStorage.initialize();
      const encounters = this.getEncountersFromStorage();
      await this.fileStorage.write({
        encounters,
        lastModified: Math.floor(Date.now() / 1000)
      });
      this.systemLogger.info('ProfileRecognitionService', `Saved ${Object.keys(encounters).length} encounters to file`);
    } catch (error) {
      this.systemLogger.error('ProfileRecognitionService', `Failed to save to file: ${error}`);
    }
  }

  /**
   * Save encounters to relays via ProfileRecognitionOrchestrator
   */
  private async saveToRelays(): Promise<void> {
    try {
      const encounters = this.getEncountersFromStorage();
      await this.orchestrator.publishToRelays({
        encounters,
        lastModified: Math.floor(Date.now() / 1000)
      });
    } catch (error) {
      this.systemLogger.error('ProfileRecognitionService', `Failed to save to relays: ${error}`);
    }
  }

  /**
   * Get all encounters from localStorage
   */
  private getEncountersFromStorage(): Record<string, ProfileEncounter> {
    return this.storage.get<Record<string, ProfileEncounter>>(StorageKeys.PROFILE_ENCOUNTERS, {});
  }
}
