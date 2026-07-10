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
 * - Persistent storage: ProfileEncounterFileStorage (Desktop file)
 * - Relay storage: ProfileRecognitionOrchestrator (NIP-78)
 */

import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { ProfileEncounterFileStorage, type ProfileEncounter } from './ProfileEncounterFileStorage';
import { TypedEventBus } from '../../core/TypedEventBus';
import { SystemLogger } from '../../services/SystemLogger';
import { FollowStorageAdapter } from '../../lists/follows';
import { UserProfileService } from '../../services/UserProfileService';
import { ContentProcessor } from '../../services/ContentProcessor';
import { ProfileRecognitionOrchestrator } from './ProfileRecognitionOrchestrator';
import { AuthService } from '../../services/AuthService';
import { PlatformService } from '../../services/PlatformService';

const FILE_SAVE_DEBOUNCE = 500; // 500ms
const RELAY_SAVE_DEBOUNCE = 5000; // 5s

export class ProfileRecognitionService {
  private static instance: ProfileRecognitionService;
  private storage: PerAccountLocalStorage;
  private fileStorage: ProfileEncounterFileStorage;
  private orchestrator: ProfileRecognitionOrchestrator;
  private eventBus: TypedEventBus;
  private systemLogger: SystemLogger;
  private followAdapter: FollowStorageAdapter;
  private userProfileService: UserProfileService;
  private authService: AuthService;

  // Debounce timers
  private fileSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  private relaySaveTimeout: ReturnType<typeof setTimeout> | null = null;

  // TypedEventBus subscription id for 'follow:updated' — stored so destroy() can off()
  private followUpdatedSubId: string | null = null;

  // Initialization state
  private initialized = false;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
    this.fileStorage = ProfileEncounterFileStorage.getInstance();
    this.orchestrator = ProfileRecognitionOrchestrator.getInstance();
    this.eventBus = TypedEventBus.getInstance();
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
      this.cleanupPoisonedEncounters();
      this.systemLogger.info('ProfileRecognitionService', `Loaded ${Object.keys(localEncounters).length} encounters from localStorage`);
      this.initialized = true;
      this.setupEventListeners();
      return;
    }

    // localStorage empty - try loading from file (desktop only)
    if (PlatformService.getInstance().isDesktop) {
      try {
        await this.fileStorage.initialize();
        const fileData = await this.fileStorage.read();

        if (Object.keys(fileData.encounters).length > 0) {
          this.systemLogger.info('ProfileRecognitionService', `Loaded ${Object.keys(fileData.encounters).length} encounters from file`);
          this.storage.set(StorageKeys.PROFILE_ENCOUNTERS, fileData.encounters);
          this.cleanupPoisonedEncounters();
          this.initialized = true;
          this.setupEventListeners();
          return;
        }
      } catch (error) {
        this.systemLogger.error('ProfileRecognitionService', `Failed to load from file: ${error}`);
      }
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
          this.cleanupPoisonedEncounters();
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
   * One-time cleanup of encounter records corrupted by the now-fixed bugs
   * (npub-fallback names, identicon pictures, and "Anon" first names from
   * unresolved profile fetches at follow time). Deletes poisoned encounters
   * so they get re-captured correctly on the next follow-sync cycle, rather
   * than blinking for 90 days (or forever with "Always" window).
   *
   * Returns the number of encounters removed.
   */
  private cleanupPoisonedEncounters(): number {
    const encounters = this.getEncountersFromStorage();
    let removed = 0;

    for (const [pubkey, enc] of Object.entries(encounters)) {
      const nameIsNpub = enc.lastKnownName?.startsWith('@npub') ?? false;
      const firstNameIsNpub = enc.firstName?.startsWith('@npub') ?? false;
      const firstNameIsAnon = enc.firstName === 'Anon';
      const pictureIsIdenticon = enc.lastKnownPictureUrl?.startsWith('data:image/svg+xml') ?? false;

      if (nameIsNpub || firstNameIsNpub || firstNameIsAnon || pictureIsIdenticon) {
        delete encounters[pubkey];
        removed++;
      }
    }

    if (removed > 0) {
      this.storage.set(StorageKeys.PROFILE_ENCOUNTERS, encounters);
      this.scheduleAutoSave();
      this.systemLogger.info('ProfileRecognitionService', `Cleaned up ${removed} poisoned encounter records`);
    }

    return removed;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Guard against duplicate subscriptions — setupEventListeners is called from
    // four branches in init(), and can now also be called again after destroy().
    if (this.followUpdatedSubId !== null) return;
    // Listen for follow/unfollow events
    this.followUpdatedSubId = this.eventBus.on('follow:updated', () => {
      this.handleFollowListChange();
    });
  }

  /**
   * Tear down the service. Called by the AddonLoader runtime when the addon
   * is toggled OFF or when the user logs out / switches account.
   *
   * Destroy contract:
   *   - clear the two debounce timeouts (fileSaveTimeout, relaySaveTimeout)
   *   - unsubscribe the 'follow:updated' listener
   *   - reset initialized so a subsequent getInstance().init() re-runs cleanly
   *   - null the static singleton reference so the next getInstance() returns
   *     a fresh instance (important on account switch — encounter state must
   *     not leak across accounts)
   */
  public destroy(): void {
    if (this.fileSaveTimeout) {
      clearTimeout(this.fileSaveTimeout);
      this.fileSaveTimeout = null;
    }
    if (this.relaySaveTimeout) {
      clearTimeout(this.relaySaveTimeout);
      this.relaySaveTimeout = null;
    }
    if (this.followUpdatedSubId !== null) {
      this.eventBus.off(this.followUpdatedSubId);
      this.followUpdatedSubId = null;
    }
    // Stop + drop all mention blinkers this addon spawned (their 2s intervals
    // live in ContentProcessor) so they don't keep firing after teardown.
    ContentProcessor.getInstance().clearAllBlinkers();
    this.initialized = false;
    // Release the singleton so account switches get a fresh instance.
    if (ProfileRecognitionService.instance === this) {
      // @ts-expect-error intentional reset of private static
      ProfileRecognitionService.instance = undefined;
    }
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
   * Record encounter for a specific pubkey (internal - fetches profile).
   * Skips recording when the profile hasn't resolved yet (no real name or
   * picture), so the next follow-sync cycle can try again with real data.
   * Recording "Anon" as an immutable firstName would cause permanent false
   * blinking once the real name arrives.
   */
  private async recordEncounterForPubkey(pubkey: string): Promise<void> {
    try {
      // Fetch current profile
      const profile = await this.userProfileService.getUserProfile(pubkey);
      const name = profile.display_name || profile.name || profile.username;
      const picture = profile.picture || '';

      // Skip if the profile hasn't resolved — no real name. A missing
      // picture is legitimate (user just didn't set one), so we don't
      // require it. Recording an unresolved name would make firstName
      // immutable and cause permanent blinking when the real name arrives.
      if (!name) {
        this.systemLogger.debug('ProfileRecognitionService', `Skipping encounter for ${pubkey.slice(0, 8)} — profile unresolved`);
        return;
      }

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
   *
   * Note: Only checks name changes, not picture URLs, because image hosting services
   * generate unique URLs even for the same image, causing false positives.
   */
  public hasChangedWithinWindow(pubkey: string): boolean {
    const encounter = this.getEncounter(pubkey);
    if (!encounter) return false;

    // Check if name actually changed (ignore picture URL)
    if (encounter.firstName === encounter.lastKnownName) {
      return false; // Name hasn't changed, stop blinking
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
   * Combined check: update last known metadata and return whether to blink.
   * Skips own profile. Returns null if recognition is not active or shouldn't blink.
   *
   * Central guard: rejects unresolved profile fallbacks (npub-style names and
   * identicon SVG data-URL pictures) so they are never treated as genuine
   * name/picture changes. Without this, a transient cache miss feeds
   * "@npub1xyz…" + an identicon into the comparison, which poisons the
   * encounter record and triggers false blinking. Every call site is covered
   * by this guard — no per-caller check needed.
   */
  public checkRecognition(pubkey: string, username: string, picture: string): ProfileEncounter | null {
    if (this.authService.isCurrentUser(pubkey)) return null;

    const encounter = this.getEncounter(pubkey);
    if (!encounter) return null;

    // Reject unresolved profiles — these are render-layer fallbacks, not real
    // identity data. Detecting them here (centrally) means call sites don't
    // need their own guards.
    if (ProfileRecognitionService.isUnresolvedFallback(username, picture)) {
      return null;
    }

    if (username !== encounter.lastKnownName || picture !== encounter.lastKnownPictureUrl) {
      this.updateLastKnown(pubkey, username, picture);
    }

    return this.hasChangedWithinWindow(pubkey) ? encounter : null;
  }

  /**
   * Detect render-layer fallback values that are NOT real profile data.
   * - Name fallback: "@npub1…" (from UserProfileService.displayNameOf when
   *   no real name exists — always starts with "@npub" and ends with "…").
   * - Picture fallback: "data:image/svg+xml…" (from getAvatarFallback —
   *   a deterministic identicon, never a real hosted image).
   */
  private static isUnresolvedFallback(username: string, picture: string): boolean {
    if (username.startsWith('@npub')) return true;
    if (picture.startsWith('data:image/svg+xml')) return true;
    return false;
  }

  /**
   * Get recognition window in days from settings
   * Returns: 0 = disabled, -1 = always, or number of days
   */
  private getRecognitionWindowDays(): number {
    try {
      return PerAccountLocalStorage.getInstance().get<number>(StorageKeys.PROFILE_RECOGNITION_WINDOW, 90);
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
   * Save encounters to file (desktop only)
   */
  private async saveToFile(): Promise<void> {
    if (!PlatformService.getInstance().isDesktop) return;
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
    if (this.authService.isBunkerAuth()) return;
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
