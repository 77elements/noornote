/**
 * ProfileView Component
 * Displays user profile (NIP-01 + NIP-24) with user timeline
 * Timeline is rendered using TimelineUI component with author filter
 * Includes profile search functionality (results in GlobalSearchView)
 */

import { View } from './View';
import {
  UserProfileService,
  type UserProfile,
} from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { UserService } from '../../services/UserService';
import { FollowVerificationService } from '../../services/FollowVerificationService';
import { RemoteMuteCheckService } from '../../services/RemoteMuteCheckService';
import { Timeline } from '../timeline/Timeline';
import { profileTimelineConfig } from '../timeline/TimelineConfig';
import { ProfileSearchComponent } from '../profile/ProfileSearchComponent';
import { ProfileFollowManager } from '../../lists/follows';
import { ProfileMuteManager } from '../../lists/mutes';
import { SoftMuteService } from '../../services/SoftMuteService';
import {
  isHighlightHiddenFor,
  setHighlightHiddenFor,
} from '../../helpers/highlightSetting';
import { ProfileEditModal } from '../profile/ProfileEditModal';
import { QRCodeModal } from '../qrcode/QRCodeModal';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { linkifyUrls } from '../../helpers/linkifyUrls';
import { convertLineBreaks } from '../../helpers/convertLineBreaks';
import { npubToUsername } from '../../helpers/npubToUsername';
import { ContentProcessor } from '../../services/ContentProcessor';
import { ClipboardActionsService } from '../../services/ClipboardActionsService';
import { Router } from '../../services/Router';
import { TypedEventBus } from '../../core/TypedEventBus';
import { AuthGuard } from '../../services/AuthGuard';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import type { ProfileListsComponent } from '../profile/ProfileListsComponent';
import { ProfileArticlesCarousel } from '../profile/ProfileArticlesCarousel';
import { ProfileVideosCarousel } from '../profile/ProfileVideosCarousel';
import { ProfileListingsCarousel } from '../profile/ProfileListingsCarousel';
import { isProfileListingsEnabled } from '../../addons/marketplace/index';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import { AddonLoader } from '../../addons/AddonLoader';
import type { ProfileRecognitionRuntime } from '../../addons/profile-recognition/runtime';

// Lazy-loaded types for profile recognition
// Types only (erased at build time) — live runtime accessed via AddonLoader
type ProfileBlinkerType =
  import('../../addons/profile-recognition/profileBlinking').ProfileBlinker;
type TextBlinkerType =
  import('../../addons/profile-recognition/profileBlinking').TextBlinker;
// ProfileOrchestrator accessed via profile module API
import dayjs from 'dayjs';
import calendarSystems from '@calidy/dayjs-calendarsystems';
import HijriCalendarSystem from '@calidy/dayjs-calendarsystems/calendarSystems/HijriCalendarSystem';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { CustomDropdown } from '../ui/CustomDropdown';
import { ToastService } from '../../services/ToastService';
import { isTribesEnabled } from '../../addons/tribes/index';
import { HIJRI_MONTHS } from '../../helpers/formatTimestamp';
import { diagLog } from '../../services/DiagnosticLogger';
import {
  escapeHtml,
  escapeHtmlAttr,
  escapeCssUrl,
  safeHttpUrl,
} from '../../helpers/escapeHtml';
import { extractDisplayName } from '../../helpers/extractDisplayName';
import { getTag } from '../../helpers/tagUtils';
import { Tooltip } from '../ui/Tooltip';

// Initialize dayjs calendar system
dayjs.extend(calendarSystems);
dayjs.registerCalendarSystem('hijri' as any, new HijriCalendarSystem());

// Shared promise map to prevent duplicate profile loads on rapid navigation
type ProfileLoadResult = {
  profile: UserProfile;
  following: string[];
  followsYou: boolean;
  mutedYou: boolean;
};
const loadingProfiles: Map<string, Promise<ProfileLoadResult>> = new Map();

export class ProfileView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private userService: UserService;
  private followVerification: FollowVerificationService;
  private remoteMuteCheck: RemoteMuteCheckService;
  private eventBus: TypedEventBus;
  private timeline: Timeline | null = null;
  private followingCount: number = 0;
  private followerCount: number = 0;
  private isLoadingFollowers: boolean = false;
  private joinedDate: string | null = null;
  private isLoadingJoinedDate: boolean = false;
  private followsYou: boolean = false;
  private mutedYou: boolean = false; // Target has PUBLICLY muted the current user
  private isInitialRender: boolean = true; // Track if this is first render
  private lastKnownMuteStatus: boolean = false; // Track mute status for change detection
  private lastKnownFollowStatus: boolean = false; // Track follow status for change detection

  // Managers
  private followManager: ProfileFollowManager;
  private muteManager: ProfileMuteManager;

  // Search component
  private searchComponent: ProfileSearchComponent | null = null;

  // Profile lists component (mounted bookmark folders)
  private profileListsComponent: ProfileListsComponent | null = null;

  // Articles carousel component
  private articlesCarousel: ProfileArticlesCarousel | null = null;
  private listingsCarousel: ProfileListingsCarousel | null = null;

  // Videos carousel component
  private videosCarousel: ProfileVideosCarousel | null = null;
  private carouselObservers: IntersectionObserver[] = [];

  // Lightning address (for profile zap buttons)
  private lud16: string = '';

  // Services
  private _profileModuleApi?: ProfileModuleApi | null;
  private get profileModuleApi(): ProfileModuleApi | null {
    return (this._profileModuleApi ??=
      ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile'));
  }

  // Profile recognition blinker instances — service + classes live in the
  // addon runtime, looked up fresh via AddonLoader at use time.
  private blinker: ProfileBlinkerType | null = null;
  private nameBlinker: TextBlinkerType | null = null;
  private profileUnsubscribe: (() => void) | null = null;

  // Tribe dropdown
  private tribeDropdown: CustomDropdown | null = null;
  private tribeDropdownCleanupHandlers: Array<
    (e: MouseEvent | KeyboardEvent) => void
  > = [];

  // TypedEventBus subscription IDs for cleanup
  private eventBusSubscriptions: string[] = [];

  // nn-tooltip disposers for the header icon row
  private tooltipDisposers: Array<() => void> = [];

  constructor(npub: string) {
    super(); // Call View base class constructor
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--profile';
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.userService = UserService.getInstance();
    this.followVerification = FollowVerificationService.getInstance();
    this.remoteMuteCheck = RemoteMuteCheckService.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    // Decode npub or nprofile to pubkey
    try {
      const decoded = decodeNip19(npub);
      if (decoded.type === 'npub') {
        this.pubkey = decoded.data;
      } else if (decoded.type === 'nprofile') {
        this.pubkey = (decoded.data as { pubkey: string }).pubkey;
      } else {
        throw new Error('Invalid npub/nprofile');
      }
    } catch (_error) {
      console.error('❌ PV: Invalid npub/nprofile', _error);
      this.pubkey = '';
    }

    // Initialize managers
    this.followManager = new ProfileFollowManager(this.pubkey);
    this.muteManager = new ProfileMuteManager(this.pubkey);

    // Listen for profile updates
    this.setupProfileUpdateListener();

    // Listen for user switches
    this.setupUserSwitchListener();

    // Listen for calendar system changes
    this.setupCalendarSystemListener();

    // Listen for mute changes (from MuteList or other sources)
    this.setupMuteChangeListener();

    // Listen for follow changes (from FollowList or other sources)
    this.setupFollowChangeListener();

    // Live updates when bookmark folder mount state changes (Profile checkbox)
    this.setupProfileMountsChangeListener();

    // No more async recognition-load dance — the addon runtime is owned by
    // AddonLoader and looked up fresh via getRecognitionRuntime() at use time.
    void this.render();
  }

  /** Fetch the current profile-recognition runtime, or null if addon is OFF. */
  private getRecognitionRuntime(): ProfileRecognitionRuntime | null {
    return AddonLoader.getInstance().getRuntime<ProfileRecognitionRuntime>(
      'profile-recognition'
    );
  }

  /**
   * Setup listener for profile updates (after save in ProfileEditModal)
   */
  private setupProfileUpdateListener(): void {
    const id = this.eventBus.on(
      'profile:updated',
      (data: { pubkey: string }) => {
        if (
          this.authService.isCurrentUser(data.pubkey) &&
          this.authService.isCurrentUser(this.pubkey)
        ) {
          // Reload own profile after edit
          void this.refreshProfile();
        }
      }
    );
    this.eventBusSubscriptions.push(id);
  }

  /**
   * Setup listener for user switches (reload profile view to update Edit button visibility)
   */
  private setupUserSwitchListener(): void {
    const id = this.eventBus.on('user:login', () => {
      // Reset initial render flag and re-render to update Edit Profile button visibility
      this.isInitialRender = true;
      void this.render();
    });
    this.eventBusSubscriptions.push(id);
  }

  /**
   * Setup listener for calendar system changes (reload joined date with new format)
   */
  private setupCalendarSystemListener(): void {
    const id = this.eventBus.on('settings:calendar-system-changed', () => {
      // Reload joined date with new calendar format
      if (this.joinedDate) {
        void this.loadJoinedDate();
      }
    });
    this.eventBusSubscriptions.push(id);
  }

  /**
   * Setup listener for mute changes (re-render if this profile's mute status changed)
   */
  private setupMuteChangeListener(): void {
    const id = this.eventBus.on('mute:updated', async () => {
      // Only re-render if this profile's mute status actually changed
      const wasMuted = this.lastKnownMuteStatus;
      const muteStatus = await this.muteManager.checkMuteStatus();
      const isMuted = muteStatus.public || muteStatus.private;

      if (wasMuted !== isMuted) {
        this.lastKnownMuteStatus = isMuted;
        this.isInitialRender = true;
        void this.render();
      }
    });
    this.eventBusSubscriptions.push(id);
  }

  /**
   * Setup listener for follow changes. When this profile's follow status
   * changed (because the follow/unfollow happened elsewhere — e.g. the
   * followers list, another tab, or the extended-follows list), refresh the
   * follow button INLINE instead of a full re-render, so the profile never
   * blanks out ("Loading profile...") just to flip a button. A direct click on
   * this PV's own button is already handled optimistically by handleFollow +
   * refreshFollowButtonInline, so this listener becomes a no-op for it.
   */
  private setupFollowChangeListener(): void {
    const id = this.eventBus.on('follow:updated', async () => {
      // Only refresh if this profile's follow status actually changed
      const wasFollowing = this.lastKnownFollowStatus;
      const isFollowing = await this.followManager.checkFollowStatus();

      if (wasFollowing !== isFollowing) {
        this.lastKnownFollowStatus = isFollowing;
        this.refreshFollowButtonInline();
      }
    });
    this.eventBusSubscriptions.push(id);
  }

  /**
   * Re-render PV inline mounts whenever the user toggles a folder's "Profile" checkbox
   */
  private setupProfileMountsChangeListener(): void {
    const id = this.eventBus.on('profileMounts:changed', () => {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser || currentUser.pubkey !== this.pubkey) return;
      void this.loadProfileLists();
    });
    this.eventBusSubscriptions.push(id);
  }

  /**
   * Refresh profile data (after edit)
   */
  private async refreshProfile(): Promise<void> {
    try {
      const profile = await this.userProfileService.getUserProfile(this.pubkey);
      this.renderProfileHeader(profile);
    } catch (_error) {
      console.error('❌ PV: Failed to refresh profile', _error);
    }
  }

  /**
   * Initial render - show loading, then load profile
   */
  private async render(): Promise<void> {
    if (!this.pubkey) {
      this.showError('Invalid profile ID');
      return;
    }

    // Show loading state
    this.container.innerHTML = `
      <div class="profile-loading">
        <div class="loading-spinner"></div>
        <p>Loading profile...</p>
      </div>
    `;

    try {
      // Get current logged-in user
      const currentUser = this.authService.getCurrentUser();

      // Check if this user is muted (only if logged in)
      if (currentUser) {
        const muteStatus = await this.muteManager.checkMuteStatus();
        const isMuted = muteStatus.public || muteStatus.private;
        this.lastKnownMuteStatus = isMuted;

        if (isMuted) {
          // Show muted profile placeholder
          await this.showMutedProfile();
          return;
        }
      }

      // Fetch profile data (uses shared promise to prevent duplicate requests)
      const { profile, following, followsYou, mutedYou } =
        await this.getProfileData();

      this.followingCount = following.length;

      // Check follow relationships (only for other profiles when logged in)
      if (currentUser && this.pubkey !== currentUser.pubkey) {
        this.followsYou = followsYou;
        this.mutedYou = mutedYou;
        const isFollowing = await this.followManager.checkFollowStatus();
        this.lastKnownFollowStatus = isFollowing;
      }

      // Render profile header
      this.renderProfileHeader(profile);

      // Load follower count (async, non-blocking)
      void this.loadFollowerCount();

      // Load joined date (async, non-blocking)
      void this.loadJoinedDate();

      // Subscribe to profile updates for live avatar/name updates.
      // Guard against stacking subscriptions if render() runs more than once.
      this.profileUnsubscribe?.();
      this.profileUnsubscribe = this.userProfileService.subscribeToProfile(
        this.pubkey,
        updatedProfile => {
          this.renderProfileHeader(updatedProfile);
        }
      );

      // Initialize search component
      this.initializeSearchComponent();

      // Mount timeline with author filter
      await this.mountTimeline();
    } catch (_error) {
      console.error('❌ PV: Failed to load profile', _error);
      this.showError('Failed to load profile');
    }
  }

  /**
   * Load follower count (async, non-blocking)
   * Updates UI after each relay completes
   */
  private async loadFollowerCount(): Promise<void> {
    this.isLoadingFollowers = true;
    this.updateFollowerDisplay(); // Start pulsing

    try {
      const count = await (this.profileModuleApi?.getFollowerCount(
        this.pubkey,
        (currentCount, _relay) => {
          // Update UI after each relay
          this.followerCount = currentCount;
          this.updateFollowerDisplay();
        }
      ) ?? Promise.resolve(0));
      // Final update
      this.followerCount = count;
      this.isLoadingFollowers = false;
      this.updateFollowerDisplay(); // Stop pulsing, remove "+"
    } catch (error) {
      console.error('Failed to load follower count:', error);
      this.followerCount = 0;
      this.isLoadingFollowers = false;
      this.updateFollowerDisplay();
    }
  }

  /**
   * Update follower count display in DOM
   */
  private updateFollowerDisplay(): void {
    const followerEl = this.container.querySelector('#followers-count');
    if (followerEl) {
      // Show count with "+" while loading, pulse effect
      if (this.isLoadingFollowers) {
        followerEl.textContent =
          this.followerCount > 0
            ? `${this.followerCount.toLocaleString('en-US')}+`
            : '...';
        followerEl.classList.add('pulsate');
      } else {
        // Final count, no pulse, no "+"
        followerEl.textContent = this.followerCount.toLocaleString('en-US');
        followerEl.classList.remove('pulsate');
      }
    }
  }

  /**
   * Load joined date (async, non-blocking)
   * Fetches oldest event from user
   */
  private async loadJoinedDate(): Promise<void> {
    this.isLoadingJoinedDate = true;
    this.updateJoinedDateDisplay();

    try {
      const oldestTimestamp =
        (await this.profileModuleApi?.fetchOldestEvent(this.pubkey)) ?? null;

      if (oldestTimestamp) {
        // Format date based on calendar system setting
        const date = new Date(oldestTimestamp * 1000);
        const storage = PerAccountLocalStorage.getInstance();
        const calendarSystem = storage.get<string>(
          StorageKeys.CALENDAR_SYSTEM,
          'gregorian'
        );

        // Format date(s) based on calendar system
        this.joinedDate = this.formatJoinedDate(date, calendarSystem);
      } else {
        this.joinedDate = null;
      }

      this.isLoadingJoinedDate = false;
      this.updateJoinedDateDisplay();
    } catch (error) {
      console.error('Failed to load joined date:', error);
      this.joinedDate = null;
      this.isLoadingJoinedDate = false;
      this.updateJoinedDateDisplay();
    }
  }

  /**
   * Format joined date based on calendar system
   */
  private formatJoinedDate(date: Date, calendarSystem: string): string {
    const gregorianFormatted = `${date.toLocaleDateString('en-US', { month: 'short' })} ${date.getDate()}, ${date.getFullYear()}`;

    if (calendarSystem === 'gregorian') {
      return gregorianFormatted;
    }

    // Format Hijri date
    const hijriDate = dayjs(date).toCalendarSystem('hijri' as any);
    const hijriFormatted = `${hijriDate.date()}. ${HIJRI_MONTHS[hijriDate.month()]} ${hijriDate.year()}`;

    if (calendarSystem === 'hijri') {
      return hijriFormatted;
    }

    // 'both' - show both formats
    return `${gregorianFormatted}  |  ${hijriFormatted}`;
  }

  /**
   * Update joined date display in DOM
   */
  private updateJoinedDateDisplay(): void {
    const joinedEl = this.container.querySelector('#profile-joined-date');
    if (joinedEl) {
      if (this.isLoadingJoinedDate) {
        joinedEl.textContent = 'Loading...';
      } else if (this.joinedDate) {
        joinedEl.textContent = `Joined Nostr on ${this.joinedDate}`;
      } else {
        joinedEl.textContent = '';
      }
    }
  }

  /**
   * Fetch profile data with shared promise to prevent duplicate requests
   */
  private async fetchProfileData(): Promise<ProfileLoadResult> {
    try {
      const isSelf = this.authService.isCurrentUser(this.pubkey);
      const [profile, following, followsYouVerdict, mutedYouVerdict] =
        await Promise.all([
          this.userProfileService.getUserProfile(this.pubkey),
          this.userService.getUserFollowing(this.pubkey),
          isSelf
            ? Promise.resolve(null)
            : this.followVerification.verifyFollowsBack(this.pubkey),
          isSelf
            ? Promise.resolve(null)
            : this.remoteMuteCheck.verifyMutedByThem(this.pubkey),
        ]);

      const followsYou = followsYouVerdict?.status === 'follows';
      const mutedYou = mutedYouVerdict?.status === 'muted';
      return { profile, following, followsYou, mutedYou };
    } finally {
      // Remove from loading map after completion (success or error)
      loadingProfiles.delete(this.pubkey);
    }
  }

  /**
   * Get profile data, reusing in-flight request if available
   */
  private async getProfileData(): Promise<ProfileLoadResult> {
    let loadPromise = loadingProfiles.get(this.pubkey);
    if (!loadPromise) {
      loadPromise = this.fetchProfileData();
      loadingProfiles.set(this.pubkey, loadPromise);
    }
    return loadPromise;
  }

  /**
   * Render profile header section
   */
  private renderProfileHeader(profile: UserProfile): void {
    const displayName = extractDisplayName(profile) || 'Anonymous';
    const about = profile.about || '';
    const website = profile.website || '';
    const banner = profile.banner || '';
    const picture =
      profile.picture ||
      this.userProfileService.getProfilePicture(this.pubkey) ||
      '';
    // Multiple NIP-05: prefer nip05s from tags, fallback to single nip05 from content
    const nip05s =
      profile.nip05s && profile.nip05s.length > 0
        ? profile.nip05s
        : profile.nip05
          ? [profile.nip05]
          : [];
    const lud16 = profile.lud16 || '';
    this.lud16 = lud16;
    const isOwnProfile = this.authService.isCurrentUser(this.pubkey);
    const isBunker = this.authService.isBunkerAuth();

    // Process about text: escape HTML, convert line breaks, linkify URLs, and turn
    // npub/nprofile mentions into clickable chips (same resolver as note content, so
    // the loading chips get upgraded in place once the profile loads).
    const processedAbout = about
      ? npubToUsername(
          linkifyUrls(convertLineBreaks(escapeHtml(about))),
          'html-multi',
          (hex: string) =>
            ContentProcessor.getInstance().getNonBlockingProfile(hex)
        )
      : '';

    const headerHTML = `
      <div class="profile-nip01">
        ${
          banner
            ? `
          <div class="profile-banner" style="background-image: url('${escapeCssUrl(banner)}')"></div>
        `
            : `
          <div class="profile-banner profile-banner-fallback"></div>
        `
        }
        <div class="profile-info">
          <div class="profile-avatar-wrapper">
            <img src="${escapeHtmlAttr(picture)}" alt="${escapeHtml(displayName)}" class="profile-pic profile-pic--big" />
            ${this.followsYou ? '<span class="badge badge--green">Follows you</span>' : ''}
            ${this.mutedYou ? '<span class="badge badge--red">Has muted you</span>' : ''}
          </div>

          <div class="profile-meta">
            <h1 class="profile-name">${escapeHtml(displayName)}<span class="profile-petname" data-role="petname"></span><span class="profile-petname-note" data-role="petname-note"></span></h1>
            ${nip05s.length > 0 ? `<p class="profile-nip05">${nip05s.map(n => escapeHtml(n)).join(', ')}</p>` : ''}
            <p class="profile-status${isOwnProfile ? ' profile-status--editable' : ''}" data-role="status" ${isOwnProfile ? '' : 'hidden'}></p>

            ${
              lud16
                ? `
              <div class="profile-lightning">
                <svg class="lightning-icon"><use href="#icon-lightning-filled"/></svg>
                <span>${escapeHtml(lud16)}</span>
              </div>
            `
                : ''
            }

            <div class="profile-stats">
              <div class="stat-item stat-item--clickable" id="following-count-link">
                <strong>${this.followingCount.toLocaleString('en-US')}</strong>
                <span>Following</span>
              </div>
              <div class="stat-item stat-item--clickable" id="followers-count-link">
                <strong id="followers-count">${this.followerCount ? this.followerCount.toLocaleString('en-US') : '...'}</strong>
                <span>Followers</span>
              </div>
            </div>

            <div class="profile-joined-date" id="profile-joined-date"></div>

            <div class="profile-npub">
              <button class="copy-btn" data-copy="${escapeHtml(this.npub)}" title="Copy npub">
                <svg width="18" height="18"><use href="#icon-copy-24"/></svg>
              </button>
              <button class="qr-btn" title="npub QR Code">
                <svg width="18" height="18"><use href="#icon-qr-code"/></svg>
              </button>
              ${this.renderTribeButton()}
              <button class="profile-badge-btn" title="Award Badge" style="display:none">
                <svg width="18" height="18"><use href="#icon-badge"/></svg>
              </button>
              ${
                !isOwnProfile
                  ? `
              <button class="profile-dm-btn"${isBunker ? ' disabled' : ''} title="${isBunker ? 'Switch to NoorSigner or browser extension to send messages' : 'Send message'}">
                <svg width="18" height="18"><use href="#icon-message"/></svg>
              </button>
              `
                  : ''
              }
              ${
                lud16 && !isOwnProfile
                  ? `
              <button class="lightning-qr-btn" title="Lightning QR Code">
                <svg width="18" height="18"><use href="#icon-lightning-qr"/></svg>
              </button>
              <button class="profile-zap-btn" title="Zap this user">
                <svg width="18" height="18"><use href="#icon-lightning-filled"/></svg>
              </button>
              `
                  : ''
              }
              <div class="textinput-overlay-mount"></div>
              <span class="copy-feedback">Copied!</span>
            </div>

            <div class="profile-actions">
              ${this.renderEditButton()}
              ${this.renderFollowButton()}
              ${this.renderMuteButton()}
            </div>

            ${processedAbout ? `<p class="profile-about section">${processedAbout}</p>` : ''}
            ${website && safeHttpUrl(website) ? `<p class="profile-website section"><a href="${escapeHtmlAttr(safeHttpUrl(website))}" rel="noopener noreferrer">${escapeHtml(website)}</a></p>` : ''}
          </div>
        </div>

      </div>

      <div class="profile-tabs tabs tabs--scrollable">
        <button class="tab tab--active" data-tab="notes" type="button">Notes</button>
        <button class="tab" data-tab="articles" type="button">Articles</button>
        <button class="tab" data-tab="videos" type="button">Videos</button>
        <button class="tab" data-tab="products" type="button">Products</button>
        <button class="tab" data-tab="zapstore" type="button">Zapstore</button>
        <button class="tab" data-tab="badges" type="button">Badges</button>
      </div>

      <div class="profile-badges-mount profile-section" data-section="badges" hidden></div>
      <div class="profile-articles-mount profile-section" data-section="articles" hidden></div>
      <div class="profile-videos-mount profile-section" data-section="videos" hidden></div>
      <div class="profile-listings-mount profile-section" data-section="products" hidden></div>
      <div class="profile-zapstore-mount profile-section" data-section="zapstore" hidden></div>
      <div class="profile-timeline profile-section" data-section="notes">
        <h2 class="profile-timeline-heading visually-hidden">Notes</h2>
      </div>
    `;

    // Only use innerHTML on first render to avoid destroying mounted timeline
    if (this.isInitialRender) {
      this.container.innerHTML = headerHTML;
      this.isInitialRender = false;

      // Setup copy button handlers
      this.setupCopyButtons();

      // Load profile lists (mounted bookmark folders)
      void this.loadProfileLists();

      // Below-the-fold carousels: lazy-load each when its mount scrolls near
      // the viewport, so opening a profile doesn't fire every carousel's relay
      // fetch at once (staggers the initial relay burst). Each loader still
      // self-gates (mount/preference checks).
      // Profile content tabs: Notes is the default; the other sections load the
      // first time their tab is opened (replaces the old scroll-lazy carousels).
      this.setupProfileTabs();

      // Setup QR code button handler
      this.setupQRButton();

      // Setup Lightning QR + Profile Zap buttons
      this.setupLightningButtons();

      // Setup DM button (foreign profiles only, navigates to messages)
      this.setupDmButton();

      // Setup tribe button handler
      this.setupTribeButton();

      // Setup badge award button (visible when addon enabled + foreign profile)
      this.setupBadgeButton();

      // Setup petname display + click-to-edit
      this.setupPetname();

      // Setup NIP-38 status line (display for others, inplace edit for own)
      this.setupStatus();

      // Setup edit button handler
      this.setupEditButton();

      // Setup follow button handler
      this.setupFollowButton();

      // Setup profile image click handler (zoom to full size)
      this.setupProfileImageClick(picture, banner);

      // Setup profile blinking (initial render)
      this.setupProfileBlinking(displayName, picture);

      // Replace the icon row's native title tooltips with nn-tooltips
      this.attachIconTooltips();
    } else {
      // On subsequent renders (profile updates), only update dynamic parts without destroying timeline

      // Update avatar and name with blinking logic
      const avatar = this.container.querySelector(
        '.profile-pic--big'
      ) as HTMLImageElement;
      const nameEl = this.container.querySelector(
        '.profile-name'
      ) as HTMLElement;
      if (avatar && nameEl) {
        this.updateProfileWithBlinking(avatar, nameEl, displayName, picture);
      }

      // Update NIP-05(s)
      const nip05El = this.container.querySelector('.profile-nip05');
      if (nip05s.length > 0 && nip05El) {
        nip05El.textContent = nip05s.join(', ');
      } else if (nip05s.length === 0 && nip05El) {
        nip05El.remove();
      }

      // Update about
      const aboutEl = this.container.querySelector('.profile-about');
      if (processedAbout && aboutEl) {
        aboutEl.innerHTML = processedAbout;
      } else if (!processedAbout && aboutEl) {
        aboutEl.remove();
      }

      // Update banner
      const bannerEl = this.container.querySelector(
        '.profile-banner'
      ) as HTMLElement;
      if (bannerEl && banner) {
        bannerEl.style.backgroundImage = `url('${escapeCssUrl(banner)}')`;
        bannerEl.classList.remove('profile-banner-fallback');
      }
    }

    // Setup mute button handler
    this.setupMuteButton();

    // Setup following count click handler
    this.setupFollowingCountLink();
    this.setupFollowersCountLink();
  }

  /**
   * Setup following count click handler
   */
  private setupFollowingCountLink(): void {
    const followingLink = this.container.querySelector('#following-count-link');
    if (!followingLink) return;

    // Remove old listeners to prevent duplicates
    const newLink = followingLink.cloneNode(true);
    followingLink.parentNode?.replaceChild(newLink, followingLink);

    newLink.addEventListener('click', () => {
      // Pass pubkey to show this profile's follows (not own follows)
      TypedEventBus.getInstance().emit('list:open', {
        listType: 'follows',
        pubkey: this.pubkey,
      });
    });
  }

  /**
   * Setup followers count click handler — opens the list of users who follow
   * this profile (mirrors the Following list, different data source).
   */
  private setupFollowersCountLink(): void {
    const followersLink = this.container.querySelector('#followers-count-link');
    if (!followersLink) return;

    // Remove old listeners to prevent duplicates
    const newLink = followersLink.cloneNode(true);
    followersLink.parentNode?.replaceChild(newLink, followersLink);

    newLink.addEventListener('click', () => {
      TypedEventBus.getInstance().emit('list:open', {
        listType: 'followers',
        pubkey: this.pubkey,
      });
    });
  }

  /**
   * Render Edit Profile button (only if viewing own profile)
   */
  private renderEditButton(): string {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser || currentUser.pubkey !== this.pubkey) {
      return '';
    }

    return `
      <button class="btn" data-action="edit-profile" title="Edit your profile">
        <svg width="16" height="16"><use href="#icon-edit"/></svg>
        Edit Profile
      </button>
    `;
  }

  /**
   * Setup edit profile button event handler
   */
  private setupEditButton(): void {
    const editBtn = this.container.querySelector(
      '[data-action="edit-profile"]'
    );
    if (!editBtn) return;

    editBtn.addEventListener('click', async () => {
      // Check authentication with AuthGuard
      const isAuthenticated = AuthGuard.requireAuth('edit profile');
      if (!isAuthenticated) return;

      // Open profile edit modal
      const profileEditModal = ProfileEditModal.getInstance();
      void profileEditModal.show();
    });
  }

  /**
   * Render Follow/Unfollow button (only if logged in and not own profile)
   */
  private renderFollowButton(): string {
    return this.followManager.renderFollowButton();
  }

  /**
   * Render mute button (public/private dropdown when enabled) and article notification checkbox
   */
  private renderMuteButton(): string {
    const muteButton = this.muteManager.renderMuteButton();

    // Add article notification checkbox (only if logged in and not own profile)
    if (
      !this.authService.getCurrentUser() ||
      this.authService.isCurrentUser(this.pubkey)
    ) {
      return muteButton;
    }

    const softMuteButton = this.renderSoftMuteButton();

    const articlesApi =
      ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
    const isSubscribed =
      articlesApi?.isSubscribedToArticleNotifications(this.pubkey) ?? false;

    const articleNotifCheckbox = `
      <label class="nn-checkbox" title="Get notified when this user posts a new article">
        <input type="checkbox" id="article-notif-toggle" ${isSubscribed ? 'checked' : ''} />
        <span>Article alerts</span>
      </label>
    `;

    const highlightsCheckbox = `
      <label class="nn-checkbox" title="Hide this user's website highlights and reposts of them from your timelines">
        <input type="checkbox" id="highlights-toggle" ${isHighlightHiddenFor(this.pubkey) ? 'checked' : ''} />
        <span>Turn off Highlights</span>
      </label>
    `;

    return (
      muteButton + softMuteButton + articleNotifCheckbox + highlightsCheckbox
    );
  }

  /**
   * Render the Soft Mute button — suppresses only notifications from this user's
   * interactions with your notes. Their posts / replies / PV stay fully visible.
   * Text swaps in place between "Soft mute" and "Soft muted"; no class change.
   */
  private renderSoftMuteButton(): string {
    const isSoftMuted = SoftMuteService.getInstance().isSoftMuted(this.pubkey);
    const label = isSoftMuted ? 'Soft muted' : 'Soft mute';
    return `<button class="btn btn--passive soft-mute-btn" data-action="soft-mute" title="Only suppresses notifications from this user's interactions with your notes">${label}</button>`;
  }

  /**
   * Render Tribe button (only if logged in and not own profile)
   */
  private renderTribeButton(): string {
    // Don't show if not logged in or on own profile
    if (
      !this.authService.getCurrentUser() ||
      this.authService.isCurrentUser(this.pubkey)
    ) {
      return '';
    }

    return `
      <button class="tribe-btn" title="Add to Tribe" style="display:none">
        <svg width="16" height="16"><use href="#icon-tribe-profile"/></svg>
      </button>
      <div class="tribe-dropdown-mount"></div>
    `;
  }

  /**
   * Setup follow button event handler
   */
  private setupFollowButton(): void {
    this.followManager.setupFollowButton(this.container, () => {
      this.refreshFollowButtonInline();
    });
  }

  /**
   * Swap the follow/unfollow button in place to reflect the current follow
   * state, without a full profile re-render. Finds the existing follow control
   * anywhere in the profile header and replaces it with a freshly rendered one,
   * then re-attaches its handlers. Shared by the direct-click path
   * (setupFollowButton's onStateChange) and the follow:updated listener so
   * neither path blanks the profile. Querying the whole container (rather than
   * a specific sub-section) keeps this robust regardless of where the button
   * lives in the header markup.
   */
  private refreshFollowButtonInline(): void {
    const existingButton = this.container.querySelector(
      '[data-action="follow"], [data-action="unfollow"], .follow-dropdown-container'
    ) as HTMLElement | null;
    if (!existingButton) return;
    const html = this.renderFollowButton();
    if (!html) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    const newButton = wrapper.firstElementChild as HTMLElement | null;
    if (newButton) {
      existingButton.replaceWith(newButton);
      this.setupFollowButton();
    }
  }

  /**
   * Setup mute button event handler
   */
  private setupMuteButton(): void {
    this.muteManager.setupMuteButton(this.container, () => {
      // Force full re-render (mute state changes HTML structure completely)
      this.isInitialRender = true;
      void this.render();
    });

    // Setup soft-mute button handler
    this.setupSoftMuteButton();

    // Setup article notification checkbox handler.
    // Clone the node first to drop any listeners attached by earlier
    // renderProfileHeader() passes — setupMuteButton() runs on every
    // re-render while the element is only recreated on the first.
    const articleNotifCheckbox = this.container.querySelector(
      '#article-notif-toggle'
    ) as HTMLInputElement;
    if (articleNotifCheckbox) {
      const freshArticleNotif = articleNotifCheckbox.cloneNode(
        true
      ) as HTMLInputElement;
      articleNotifCheckbox.parentNode?.replaceChild(
        freshArticleNotif,
        articleNotifCheckbox
      );
      freshArticleNotif.addEventListener('change', () => {
        const articlesApi =
          ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
        articlesApi?.toggleArticleNotifications(this.pubkey);
      });
    }

    // Setup highlights toggle handler — hides this user's highlights
    // (kind 9802 with web source) from all timelines.
    // Same clone-to-dedup pattern as the article checkbox above.
    const highlightsCheckbox = this.container.querySelector(
      '#highlights-toggle'
    ) as HTMLInputElement;
    if (highlightsCheckbox) {
      const freshHighlights = highlightsCheckbox.cloneNode(
        true
      ) as HTMLInputElement;
      highlightsCheckbox.parentNode?.replaceChild(
        freshHighlights,
        highlightsCheckbox
      );
      freshHighlights.addEventListener('change', () => {
        setHighlightHiddenFor(this.pubkey, freshHighlights.checked);
        this.eventBus.emit('settings:hide-highlights-changed', {
          hidden: freshHighlights.checked,
        });
        ToastService.show(
          freshHighlights.checked
            ? "This user's highlights are now hidden"
            : "This user's highlights are shown again",
          'success'
        );
      });
    }
  }

  /**
   * Bind the Soft Mute button — toggles SoftMuteService and swaps the label
   * in place (no class change, no full re-render).
   */
  private setupSoftMuteButton(): void {
    const btn = this.container.querySelector(
      '.soft-mute-btn'
    ) as HTMLButtonElement | null;
    if (!btn) return;
    // Idempotent: renderProfileHeader() runs again on profile updates and
    // would otherwise stack another click listener on the same node each
    // pass — the toggles then cancel each other out and the button appears
    // dead. A data flag (not cloning — that would drop the attached
    // nn-tooltip) keeps exactly one listener for the node's lifetime.
    if (btn.dataset.softMuteBound === '1') return;
    btn.dataset.softMuteBound = '1';
    btn.addEventListener('click', () => {
      SoftMuteService.getInstance().toggleSoftMute(this.pubkey);
      const muted = SoftMuteService.getInstance().isSoftMuted(this.pubkey);
      btn.textContent = muted ? 'Soft muted' : 'Soft mute';
      ToastService.show(
        muted
          ? 'Soft muted — their interactions no longer notify you'
          : 'Soft mute lifted',
        'success'
      );
    });
  }

  /**
   * Setup copy button event handlers
   */
  private setupCopyButtons(): void {
    const clipboardService = ClipboardActionsService.getInstance();
    const copyButtons = this.container.querySelectorAll('.copy-btn');

    copyButtons.forEach(button => {
      button.addEventListener('click', async e => {
        e.preventDefault();
        const textToCopy = (button as HTMLElement).dataset.copy;
        if (textToCopy) {
          const success = await clipboardService.copyText(
            textToCopy,
            'ID',
            true
          );
          if (success) {
            clipboardService.addVisualFeedback(button as HTMLElement);
          }
        }
      });
    });
  }

  /**
   * Convert the header icon row's native `title` tooltips into nn-tooltips:
   * read each icon's title, drop it, and attach the shared Tooltip popup. The
   * title text stays the single source of the label.
   */
  private attachIconTooltips(): void {
    // Search link is handled in initializeSearchComponent() — it mounts later.
    const selectors = [
      '.copy-btn',
      '.qr-btn',
      '.tribe-btn',
      '.profile-badge-btn',
      '.profile-dm-btn',
      '.lightning-qr-btn',
      '.profile-zap-btn',
      '.soft-mute-btn',
    ];
    selectors.forEach(sel => {
      const el = this.container.querySelector(sel) as HTMLElement | null;
      const label = el?.getAttribute('title');
      if (!el || !label) return;
      el.removeAttribute('title');
      this.tooltipDisposers.push(Tooltip.attach(el, label));
    });
  }

  /**
   * Setup QR code button event handler
   */
  private setupQRButton(): void {
    const qrButton = this.container.querySelector('.qr-btn');
    if (qrButton) {
      qrButton.addEventListener('click', e => {
        e.preventDefault();
        const qrModal = QRCodeModal.getInstance();
        void qrModal.show(this.npub);
      });
    }
  }

  /**
   * Setup Lightning QR and Profile Zap button handlers
   */
  private setupLightningButtons(): void {
    const lightningQrBtn = this.container.querySelector('.lightning-qr-btn');
    if (lightningQrBtn) {
      lightningQrBtn.addEventListener('click', e => {
        e.preventDefault();
        if (this.lud16) {
          const qrModal = QRCodeModal.getInstance();
          void qrModal.showLightning(this.lud16);
        }
      });
    }

    const profileZapBtn = this.container.querySelector('.profile-zap-btn');
    if (profileZapBtn) {
      profileZapBtn.addEventListener('click', async e => {
        e.preventDefault();
        if (!AuthGuard.requireAuth('zap')) return;
        const { ZapModal } = await import('../modals/ZapModal');
        const zapModal = new ZapModal({
          authorPubkey: this.pubkey,
        });
        void zapModal.show();
      });
    }
  }

  /**
   * Setup DM button — foreign profiles only, navigates to /messages/{npub}.
   * Disabled when the viewer is on Bunker auth (NIP-04/44 unsupported).
   */
  private setupDmButton(): void {
    const dmBtn = this.container.querySelector(
      '.profile-dm-btn'
    ) as HTMLButtonElement | null;
    if (!dmBtn || dmBtn.disabled) return;
    dmBtn.addEventListener('click', e => {
      e.preventDefault();
      Router.getInstance().navigate(`/messages/${this.npub}`);
    });
  }

  private setupBadgeButton(): void {
    const badgeBtn = this.container.querySelector(
      '.profile-badge-btn'
    ) as HTMLElement | null;
    if (!badgeBtn) return;

    // Only show for foreign profiles when addon is enabled
    const isOwnProfile =
      this.authService.getCurrentUser()?.pubkey === this.pubkey;
    if (isOwnProfile) return;

    void import('../../addons/badges/index').then(({ isBadgesEnabled }) => {
      if (!isBadgesEnabled()) return;
      badgeBtn.style.display = '';

      badgeBtn.addEventListener('click', async e => {
        e.preventDefault();
        if (!AuthGuard.requireAuth('award badge')) return;

        const { BadgeService } = await import(
          '../../addons/badges/BadgeService'
        );
        const service = BadgeService.getInstance();
        const defs = await service.fetchOwnDefinitions();

        if (defs.length === 0) {
          ToastService.show(
            'No badges created yet. Create one in Addons → Badges.',
            'info'
          );
          return;
        }

        const { ModalService } = await import('../../services/ModalService');
        const content = document.createElement('div');
        content.className = 'badge-picker';
        content.innerHTML = defs
          .map(d => {
            const img = d.imageUrl
              ? `<img src="${escapeHtmlAttr(d.imageUrl)}" alt="${escapeHtmlAttr(d.name)}" />`
              : '<span class="badge-picker__emoji">🏅</span>';
            return `<div class="badge-picker__card" data-slug="${escapeHtmlAttr(d.slug)}">
            <div class="badge-picker__name">${escapeHtml(d.name)}</div>
            <div class="badge-picker__image">${img}</div>
          </div>`;
          })
          .join('');

        content.addEventListener('click', async ev => {
          const item = (ev.target as HTMLElement).closest(
            '[data-slug]'
          ) as HTMLElement | null;
          if (!item) return;
          const slug = item.dataset.slug!;
          const def = defs.find(d => d.slug === slug);
          if (!def) return;

          const issuerPubkey = this.authService.getCurrentUser()?.pubkey;
          if (!issuerPubkey) return;
          const coordinate = `30009:${issuerPubkey}:${slug}`;
          const recipientPubkey = this.pubkey;
          if (!recipientPubkey) return;

          const success = await service.awardBadge(coordinate, [
            recipientPubkey,
          ]);
          if (success) ModalService.getInstance().hide();
        });

        ModalService.getInstance().show({
          title: 'Award Badge',
          content,
          width: '360px',
          height: 'auto',
        });
      });
    });
  }

  private setupPetname(): void {
    this.setupPublicPetname();
    this.setupPrivateNote();
  }

  /**
   * Public NIP-02 petname (4th p-tag element of the contact list). Only shown
   * for users you publicly follow — NIP-02 has no slot for a petname otherwise.
   * Publicly readable by anyone who reads your contact list.
   */
  private setupPublicPetname(): void {
    const petnameEl = this.container.querySelector(
      '[data-role="petname"]'
    ) as HTMLElement | null;
    if (!petnameEl) return;

    void import('../../lists/follows').then(
      ({ isFollowing, getFollowPetname, setFollowPetname }) => {
        const render = (): void => {
          if (!isFollowing(this.pubkey).public) {
            petnameEl.textContent = '';
            petnameEl.style.display = 'none';
            return;
          }
          petnameEl.style.display = '';
          const petname = getFollowPetname(this.pubkey);
          petnameEl.textContent = petname ? ` (${petname})` : ' (+)';
        };
        render();

        petnameEl.addEventListener('click', async e => {
          e.preventDefault();
          if (!isFollowing(this.pubkey).public) return;
          const { ModalService } = await import('../../services/ModalService');
          const current = getFollowPetname(this.pubkey) ?? '';
          const result = await ModalService.getInstance().prompt({
            title: 'Set Petname',
            message:
              '⚠️ Public label, stored in your contact list (NIP-02). Anyone who reads your follow list can see it.',
            defaultValue: current,
            placeholder: 'e.g. Bob from work',
            allowEmpty: true,
          });
          if (result === null) return;
          await setFollowPetname(this.pubkey, result.trim());
          render();
        });
      }
    );
  }

  /**
   * Private encrypted note (NIP-78, NIP-44 self-encrypted). Gated behind the
   * "Private petnames" Privacy setting. Empty = peach icon, filled = warning orange.
   */
  private setupPrivateNote(): void {
    const noteEl = this.container.querySelector(
      '[data-role="petname-note"]'
    ) as HTMLElement | null;
    if (!noteEl) return;

    void import('../../services/PetnameService').then(({ PetnameService }) => {
      const service = PetnameService.getInstance();
      if (!service.isPrivateNotesEnabled()) {
        noteEl.style.display = 'none';
        return;
      }
      noteEl.style.display = '';

      const render = (): void => {
        const note = service.getPetname(this.pubkey);
        const filled = !!note;
        noteEl.classList.toggle('profile-petname-note--filled', filled);
        noteEl.title = filled ? 'Edit private note' : 'Add private note';
        noteEl.innerHTML =
          '<svg width="18" height="18"><use href="#icon-note"/></svg>';
      };
      render();

      noteEl.addEventListener('click', async e => {
        e.preventDefault();
        const { ModalService } = await import('../../services/ModalService');
        const current = service.getPetname(this.pubkey) ?? '';
        const result = await ModalService.getInstance().prompt({
          title: 'Private Note',
          message:
            '🔒 Encrypted note about this user. Only you can decrypt and read it.',
          defaultValue: current,
          placeholder: 'Write anything you want to remember about this user…',
          allowEmpty: true,
          multiline: true,
        });
        if (result === null) return;
        await service.setPetname(this.pubkey, result.trim());
        render();
      });
    });
  }

  /**
   * NIP-38 general status (kind 30315, d=general). One line under the NIP-05.
   * Foreign profiles: read-only, hidden while empty. Own profile: click to
   * edit in place (Enter/blur saves, Esc cancels, saving empty clears).
   * Saves are optimistic: the new text renders immediately, the relay publish
   * runs in the background and reverts the UI on failure.
   */
  private setupStatus(): void {
    const statusEl = this.container.querySelector(
      '[data-role="status"]'
    ) as HTMLElement | null;
    if (!statusEl) return;

    void import('../../services/UserStatusService').then(
      ({ UserStatusService }) => {
        const service = UserStatusService.getInstance();
        const editable = statusEl.classList.contains(
          'profile-status--editable'
        );
        let current = '';
        // Set once the initial relay fetch resolves. A late fetch must not
        // overwrite an optimistic edit made before it arrived.
        let fetched = false;

        const render = (): void => {
          const hasText = !!current;
          statusEl.classList.toggle('profile-status--empty', !hasText);
          statusEl.textContent = hasText ? current : '';
          if (!editable) statusEl.hidden = !hasText;
        };

        void service.getStatus(this.pubkey).then(text => {
          if (fetched) return; // optimistic edit already won
          current = text ?? '';
          render();
          fetched = true;
        });

        if (!editable) return;

        statusEl.addEventListener('click', () => {
          if (statusEl.querySelector('input')) return; // already editing

          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'input profile-status__input';
          input.placeholder = 'Set status…';
          input.maxLength = 140;

          let done = false;
          const finish = (save: boolean): void => {
            if (done) return;
            done = true;
            const value = input.value.trim();
            input.remove();
            if (!save || value === current) {
              render();
              return;
            }

            // Optimistic: show the new status immediately, publish in the
            // background. Revert if the publish fails (Toast/diagLog come from
            // the service). Concurrent edits are safe: kind 30315 is
            // replaceable, the relay keeps the latest created_at.
            const previous = current;
            current = value;
            fetched = true;
            render();
            void service.setStatus(value).then(ok => {
              if (!ok) {
                current = previous;
                render();
              }
            });
          };

          input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finish(false);
            }
          });
          input.addEventListener('blur', () => finish(true));

          statusEl.classList.remove('profile-status--empty');
          statusEl.textContent = '';
          statusEl.appendChild(input);
          input.value = current;
          input.focus();
          input.select();
        });
      }
    );
  }

  /**
   * Setup tribe button event handler
   */
  private setupTribeButton(): void {
    const tribeButton = this.container.querySelector(
      '.tribe-btn'
    ) as HTMLElement;
    if (!tribeButton) return;
    if (!isTribesEnabled()) return;

    // Show button (hidden by default in HTML)
    tribeButton.style.display = '';

    tribeButton.addEventListener('click', async e => {
      e.preventDefault();

      // Check authentication
      const isAuthenticated = AuthGuard.requireAuth('add to tribe');
      if (!isAuthenticated) return;

      // Get all tribes
      const tribes = await import('../../lists/tribes');
      const tribeFolders = tribes.getFolders();

      if (tribeFolders.length === 0) {
        ToastService.show(
          'No tribes found. Create a tribe first in the Tribe view.',
          'info'
        );
        return;
      }

      // Build dropdown options with placeholder first
      const options = [
        { value: '', label: 'Choose a tribe' },
        ...tribeFolders.map(folder => ({
          value: folder.id,
          label: folder.name,
        })),
      ];

      // Show dropdown
      this.showTribeDropdown(options);
    });
  }

  /**
   * Show tribe selection dropdown
   */
  private showTribeDropdown(options: { value: string; label: string }[]): void {
    // Cleanup existing dropdown and listeners
    this.cleanupTribeDropdown();

    const dropdownMount = this.container.querySelector('.tribe-dropdown-mount');
    if (!dropdownMount) return;

    // Create dropdown
    this.tribeDropdown = new CustomDropdown({
      options,
      selectedValue: '',
      onChange: folderId => {
        // Close dropdown if placeholder selected
        if (!folderId) {
          this.cleanupTribeDropdown();
          return;
        }
        void this.handleTribeSelection(folderId);
      },
      className: 'tribe-dropdown',
      width: '200px',
    });

    // Mount dropdown
    dropdownMount.appendChild(this.tribeDropdown.getElement());

    // Auto-open dropdown
    const trigger = this.tribeDropdown
      .getElement()
      .querySelector('.custom-dropdown__trigger') as HTMLElement;
    if (trigger) {
      trigger.click();
    }

    // Cleanup dropdown when clicking outside or ESC
    const cleanupHandler = (e: MouseEvent | KeyboardEvent) => {
      const dropdownEl = this.tribeDropdown?.getElement();
      if (!dropdownEl) return;

      const isClickOutside =
        e instanceof MouseEvent && !dropdownEl.contains(e.target as Node);
      const isEscape = e instanceof KeyboardEvent && e.key === 'Escape';

      if (isClickOutside || isEscape) {
        this.cleanupTribeDropdown();
      }
    };

    // Store handlers for cleanup
    this.tribeDropdownCleanupHandlers = [cleanupHandler];

    // Add listeners after a small delay to avoid immediate trigger
    setTimeout(() => {
      document.addEventListener('click', cleanupHandler);
      document.addEventListener('keydown', cleanupHandler);
    }, 0);
  }

  /**
   * Cleanup tribe dropdown and event listeners
   */
  private cleanupTribeDropdown(): void {
    // Remove event listeners
    this.tribeDropdownCleanupHandlers.forEach(handler => {
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', handler);
    });
    this.tribeDropdownCleanupHandlers = [];

    // Destroy dropdown
    if (this.tribeDropdown) {
      this.tribeDropdown.destroy();
      this.tribeDropdown = null;
    }
  }

  /**
   * Handle tribe selection - adds profile user to selected tribe
   */
  private async handleTribeSelection(folderId: string): Promise<void> {
    try {
      const tribes = await import('../../lists/tribes');
      // Get folder details
      const folder = tribes.getFolder(folderId);
      if (!folder) {
        ToastService.show('Tribe not found', 'error');
        return;
      }

      // Check if user is already in THIS specific tribe
      const allMembers = tribes.getMembers();
      const isInThisTribe = allMembers.some(
        m => m.pubkey === this.pubkey && m.category === folder.name
      );

      if (isInThisTribe) {
        ToastService.show(`User is already in tribe "${folder.name}"`, 'info');
        return;
      }

      // Add member to tribe (public member)
      // IMPORTANT: Use folder.name as category (for NIP-51), but folder.id for FolderService
      tribes.addMember(
        this.pubkey,
        false, // isPrivate = false
        folder.name, // category = tribe name (for NIP-51)
        folder.id // folderId for FolderService assignment
      );

      // Explicitly emit event to trigger auto-sync in Easy Mode
      // (addMember calls setMembers which emits, but being explicit for safety)
      this.eventBus.emit('tribe:updated');

      ToastService.show(`Added to tribe "${folder.name}"`, 'success');
    } catch (error) {
      console.error('Failed to add to tribe:', error);
      ToastService.show('Failed to add to tribe', 'error');
    } finally {
      // Cleanup dropdown
      this.cleanupTribeDropdown();
    }
  }

  /**
   * Setup profile image click handler (open in ImageViewer)
   */
  private setupProfileImageClick(picture: string, banner: string): void {
    // Make profile avatar clickable
    const avatar = this.container.querySelector('.profile-pic--big');
    if (avatar) {
      avatar.classList.add('clickable');
      avatar.addEventListener('click', async () => {
        const { getImageViewer } = await import('../ui/ImageViewer');
        const imageViewer = getImageViewer();
        imageViewer.open({ images: [picture] });
      });
    }

    // Make banner clickable (if exists)
    if (banner) {
      const bannerEl = this.container.querySelector('.profile-banner');
      if (bannerEl && !bannerEl.classList.contains('profile-banner-fallback')) {
        bannerEl.classList.add('clickable');
        bannerEl.addEventListener('click', async () => {
          const { getImageViewer } = await import('../ui/ImageViewer');
          const imageViewer = getImageViewer();
          imageViewer.open({ images: [banner] });
        });
      }
    }
  }

  /**
   * Mount timeline with author filter
   */
  private async mountTimeline(): Promise<void> {
    const timelineContainer = this.container.querySelector('.profile-timeline');
    if (!timelineContainer) {
      console.error('❌ PV: Timeline container not found');
      return;
    }

    try {
      // Get current user (optional - reading doesn't require login)
      const currentUser = this.authService.getCurrentUser();

      // Use logged-in user's pubkey if available, otherwise use profile's pubkey
      // (TimelineUI needs first param, but when filterAuthorPubkey is set, following list is not used)
      const userPubkey = currentUser ? currentUser.pubkey : this.pubkey;

      // Create the timeline for a single author's complete feed
      this.timeline = new Timeline(
        userPubkey,
        profileTimelineConfig(this.pubkey)
      );

      // Mount timeline
      timelineContainer.appendChild(this.timeline.getElement());
    } catch (_error) {
      console.error('❌ PV: Failed to mount timeline', _error);
    }
  }

  /**
   * Show error message
   */
  private showError(message: string): void {
    this.container.innerHTML = `
      <div class="profile-error">
        <p>❌ ${escapeHtml(message)}</p>
      </div>
    `;
  }

  /**
   * Show muted profile placeholder with unmute options
   */
  private async showMutedProfile(): Promise<void> {
    this.container.innerHTML =
      await this.muteManager.renderMutedProfile(escapeHtml);
    this.muteManager.setupUnmuteButton(this.container, () => {
      // Reload profile after unmute
      void this.render();
    });
  }

  /**
   * Initialize search component
   */
  private initializeSearchComponent(): void {
    // Create search component with the existing search behaviour moved into
    // the onSubmit closure — the component itself is now behaviour-agnostic.
    this.searchComponent = new ProfileSearchComponent({
      onSubmit: async (searchTerms, helpers) => {
        if (!searchTerms) return;
        const profileApi = this.profileModuleApi;
        if (!profileApi) {
          helpers.showStatus('Profile module not available', 'error');
          return;
        }

        helpers.setButtonState('loading');
        try {
          const result = await profileApi.searchUserNotes({
            pubkeyHex: this.pubkey,
            searchTerms,
            onProgress: message => helpers.showStatus(message, 'info'),
          });

          this.eventBus.emit('profileSearch:complete', {
            query: searchTerms,
            results: result.events,
            meta: `${result.matchCount} match${result.matchCount !== 1 ? 'es' : ''} found (searched ${result.totalNotes} note${result.totalNotes !== 1 ? 's' : ''} from ${result.dateRange.start} to ${result.dateRange.end})`,
          });

          helpers.hideStatus();
          helpers.setButtonState('idle');
          helpers.collapse();
        } catch (error) {
          console.error('[ProfileSearch] Search failed:', error);
          helpers.showStatus(`Search failed: ${error}`, 'error');
          helpers.setButtonState('idle');
        }
      },
    });

    // Mount search component in header
    const searchMount = this.container.querySelector(
      '.textinput-overlay-mount'
    );
    if (searchMount && this.searchComponent) {
      searchMount.appendChild(this.searchComponent.getElement());

      // The search trigger mounts after attachIconTooltips() ran, so give it its
      // nn-tooltip here (drop the native title, attach the shared popup).
      const searchLink = searchMount.querySelector(
        '.textinput-overlay__link'
      ) as HTMLElement | null;
      const label = searchLink?.getAttribute('title');
      if (searchLink && label) {
        searchLink.removeAttribute('title');
        this.tooltipDisposers.push(Tooltip.attach(searchLink, label));
      }
    }
  }

  /**
   * Load profile lists (mounted bookmark folders) — inline on PV
   * Re-runnable: destroys the previous component before re-rendering.
   */
  private async loadProfileLists(): Promise<void> {
    // Anchor for ProfileListsComponent — it inserts the rendered Portfolio
    // sibling AFTER this element. `.profile-nip01` is the profile-header
    // wrapper; rendering after it lands the Portfolio between the header
    // and the articles/timeline sections (same position as before the
    // dedicated mount div was removed).
    const anchor = this.container.querySelector('.profile-nip01');
    if (!anchor) return;

    const { isBookmarksEnabled } = await import('../../addons/bookmarks/index');
    if (!isBookmarksEnabled()) return;

    if (this.profileListsComponent) {
      this.profileListsComponent.destroy();
      this.profileListsComponent = null;
    }

    const { ProfileListsComponent: PLC } = await import(
      '../profile/ProfileListsComponent'
    );
    this.profileListsComponent = new PLC(this.pubkey);
    await this.profileListsComponent.render(anchor);
  }

  /**
   * Wire the profile content tabs: switch the visible section on click and load
   * each section's content the first time its tab is opened. Notes is the
   * default and loads via the timeline; the others load on demand.
   */
  private setupProfileTabs(): void {
    const tabRow = this.container.querySelector('.profile-tabs');
    if (!tabRow) return;

    // Every non-notes tab starts hidden; it appears once its section loads with
    // at least one item. Notes is always present and is the default.
    tabRow.querySelectorAll('.tab').forEach(btn => {
      const t = (btn as HTMLElement).dataset.tab;
      if (t && t !== 'notes') (btn as HTMLElement).hidden = true;
    });

    const activate = (tab: string): void => {
      tabRow.querySelectorAll('.tab').forEach(btn => {
        btn.classList.toggle(
          'tab--active',
          (btn as HTMLElement).dataset.tab === tab
        );
      });
      this.container.querySelectorAll('.profile-section').forEach(sec => {
        (sec as HTMLElement).hidden =
          (sec as HTMLElement).dataset.section !== tab;
      });
    };

    tabRow.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab;
        if (tab) activate(tab);
      });
    });

    // Load each content section into its (hidden) mount up front, then reveal
    // its tab if it ended up with at least one item.
    const sections: Array<{ tab: string; loader: () => Promise<void> }> = [
      { tab: 'articles', loader: () => this.loadArticlesCarousel() },
      { tab: 'videos', loader: () => this.loadVideosCarousel() },
      { tab: 'products', loader: () => this.loadListingsCarousel() },
      { tab: 'zapstore', loader: () => this.loadZapstoreApps() },
      { tab: 'badges', loader: () => this.loadBadgesCarousel() },
    ];
    sections.forEach(({ tab, loader }) => {
      void loader()
        .then(() => this.revealTabIfHasItems(tab))
        .catch(() => {});
    });
  }

  /**
   * Reveal a content tab if its section rendered at least one item. Articles /
   * videos / listings self-gate by setting display:none on an empty carousel;
   * badges / zapstore render nothing into the mount when empty — so a section
   * "has items" iff it holds a child that isn't display:none.
   */
  private revealTabIfHasItems(tab: string): void {
    const section = this.container.querySelector(
      `.profile-section[data-section="${tab}"]`
    );
    const hasItems =
      !!section &&
      [...section.children].some(
        c => (c as HTMLElement).style.display !== 'none'
      );
    if (!hasItems) return;
    const tabBtn = this.container.querySelector(
      `.profile-tabs .tab[data-tab="${tab}"]`
    ) as HTMLElement | null;
    if (tabBtn) tabBtn.hidden = false;
  }

  private async loadBadgesCarousel(): Promise<void> {
    const badgesMount = this.container.querySelector('.profile-badges-mount');
    if (!badgesMount) return;

    const { NostrTransport } = await import(
      '../../services/transport/NostrTransport'
    );
    const { RelayConfig } = await import('../../services/RelayConfig');
    const { OutboundRelaysOrchestrator } = await import(
      '../../services/orchestration/OutboundRelaysOrchestrator'
    );
    const transport = NostrTransport.getInstance();
    const baseRelays = [
      ...transport.getReadRelays(),
      ...RelayConfig.getInstance().getAggregatorRelays(),
    ];

    // Also include the profile owner's outbound relays (NIP-65)
    let relays = baseRelays;
    try {
      const outbound =
        await OutboundRelaysOrchestrator.getInstance().getCombinedRelays(
          [this.pubkey],
          true
        );
      relays = [...new Set([...baseRelays, ...outbound])];
    } catch {
      /* fall back to base relays */
    }

    // Fetch kind:10008 (new) and kind:30008 (legacy) for this profile
    const events = await transport.fetch(
      relays,
      [{ kinds: [10008 as number, 30008 as number], authors: [this.pubkey] }],
      5000,
      false,
      'PV-Badges'
    );

    if (events.length === 0) return;

    // Prefer kind:10008 over kind:30008
    const profileBadges =
      events.find(e => e.kind === 10008) || events.find(e => e.kind === 30008);
    if (!profileBadges) return;

    // Parse alternating a+e tag pairs, deduplicate by coordinate
    const pairs: { coordinate: string; awardId: string }[] = [];
    const seenCoordinates = new Set<string>();
    const tags = profileBadges.tags;
    for (let i = 0; i < tags.length - 1; i++) {
      if (tags[i]![0] === 'a' && tags[i + 1]![0] === 'e') {
        const coord = tags[i]![1]!;
        if (!seenCoordinates.has(coord)) {
          seenCoordinates.add(coord);
          pairs.push({ coordinate: coord, awardId: tags[i + 1]![1]! });
        }
        i++;
      }
    }

    if (pairs.length === 0) return;

    const { BadgeOrchestrator } = await import(
      '../../services/orchestration/BadgeOrchestrator'
    );
    const orch = BadgeOrchestrator.getInstance();

    const section = document.createElement('div');
    section.className = 'profile-badges-carousel section';
    section.innerHTML =
      '<h2>Badges</h2><div class="profile-badges-carousel__list"></div>';
    badgesMount.appendChild(section);

    const list = section.querySelector('.profile-badges-carousel__list')!;
    const shown = pairs.slice(0, 8);
    const defsMap = await orch.fetchBadgeDefinitions(
      shown.map(p => p.coordinate)
    );
    for (const pair of shown) {
      const def = defsMap.get(pair.coordinate);
      if (!def) continue;

      const thumb = document.createElement('div');
      thumb.className = 'profile-badges-carousel__thumb';
      thumb.title = def.name;

      if (def.thumb || def.image) {
        thumb.innerHTML = `<img src="${escapeHtmlAttr(def.thumb || def.image || '')}" alt="${escapeHtmlAttr(def.name)}" loading="lazy" />`;
      } else {
        thumb.textContent = '🏅';
        thumb.classList.add('profile-badges-carousel__thumb--emoji');
      }

      const capturedDef = def;
      thumb.addEventListener('click', async () => {
        const { ModalService } = await import('../../services/ModalService');
        const content = document.createElement('div');
        const imgHtml =
          capturedDef.thumb || capturedDef.image
            ? `<img src="${escapeHtmlAttr(capturedDef.image || capturedDef.thumb || '')}" alt="${escapeHtmlAttr(capturedDef.name)}" />`
            : '<div>🏅</div>';
        const issuerName = (
          await import('../../services/UserProfileService')
        ).UserProfileService.getInstance().getDisplayName(
          capturedDef.issuerPubkey
        );
        const issuerNpub = (await import('../../helpers/nip19')).hexToNpub(
          capturedDef.issuerPubkey
        );
        content.innerHTML = `
          <div>${imgHtml}</div>
          ${capturedDef.description ? `<p>${escapeHtml(capturedDef.description)}</p>` : ''}
          <p>by <a href="/profile/${issuerNpub}" class="mention-link">${escapeHtml(issuerName)}</a></p>
        `;
        ModalService.getInstance().show({
          title: capturedDef.name,
          content,
          width: '360px',
          height: 'auto',
        });
      });

      list.appendChild(thumb);
    }

    if (pairs.length > 8) {
      const more = document.createElement('span');
      more.textContent = `+${pairs.length - 8}`;
      more.className = 'profile-badges-carousel__more';
      list.appendChild(more);
    }
  }

  /**
   * Load articles carousel (user's long-form articles)
   */
  /** Carousel-styled "Loading …" placeholder shown while the (now wait-for-all) fetch runs. */
  private appendCarouselLoading(
    mount: Element,
    title: string,
    label: string
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = 'nn-scroll-carousel';
    el.innerHTML = `<div class="nn-scroll-carousel__header"><h2 class="nn-scroll-carousel__title">${title}</h2></div><div class="nn-scroll-carousel__loading pulsate">${label}</div>`;
    mount.appendChild(el);
    return el;
  }

  private async loadArticlesCarousel(): Promise<void> {
    const articlesMount = this.container.querySelector(
      '.profile-articles-mount'
    );
    if (!articlesMount) return;

    const loading = this.appendCarouselLoading(
      articlesMount,
      'Articles',
      'Loading articles…'
    );
    this.articlesCarousel = new ProfileArticlesCarousel(this.pubkey);
    const element = await this.articlesCarousel.render();
    loading.remove();
    articlesMount.appendChild(element);
  }

  /**
   * Load videos carousel (user's video notes)
   */
  private async loadVideosCarousel(): Promise<void> {
    const videosMount = this.container.querySelector('.profile-videos-mount');
    if (!videosMount) return;

    const loading = this.appendCarouselLoading(
      videosMount,
      'Videos',
      'Loading videos…'
    );
    this.videosCarousel = new ProfileVideosCarousel(this.pubkey);
    const element = await this.videosCarousel.render();
    loading.remove();
    videosMount.appendChild(element);
  }

  /**
   * Load NIP-99 listings carousel — gated by the viewer's local
   * `isProfileListingsEnabled()` preference. Applies uniformly to own
   * and foreign profiles. Listings are public events, no NIP-78 sync
   * required.
   */
  private async loadListingsCarousel(): Promise<void> {
    if (!isProfileListingsEnabled()) return;

    const mount = this.container.querySelector('.profile-listings-mount');
    if (!mount) return;

    this.listingsCarousel = new ProfileListingsCarousel(this.pubkey);
    const element = await this.listingsCarousel.render();
    mount.appendChild(element);
  }

  /**
   * Load Zapstore apps for this user
   */
  private async loadZapstoreApps(): Promise<void> {
    const mount = this.container.querySelector('.profile-zapstore-mount');
    if (!mount) {
      diagLog('system', 'ZapstoreApps: mount element not found', {
        pubkey: this.pubkey.slice(0, 8),
      });
      return;
    }

    try {
      const { NostrTransport } = await import(
        '../../services/transport/NostrTransport'
      );
      const transport = NostrTransport.getInstance();

      diagLog('system', 'ZapstoreApps: fetching', {
        pubkey: this.pubkey.slice(0, 8),
      });

      const events = await transport.fetch(
        ['wss://relay.zapstore.dev'],
        [{ kinds: [32267 as any], authors: [this.pubkey], limit: 10 }],
        8000,
        false,
        'ZapstoreApps'
      );

      diagLog('system', `ZapstoreApps: fetch result`, {
        pubkey: this.pubkey.slice(0, 8),
        eventCount: events.length,
      });

      if (events.length === 0) return;

      const { encodeNaddr } = await import('../../services/NostrToolsAdapter');
      const { escapeHtml, escapeHtmlAttr } = await import(
        '../../helpers/escapeHtml'
      );

      // Each app renders as a Note-Card-style card: icon + name + summary header,
      // description, and a row of screenshots. No interactions / replies (those
      // live on the app's detail page, opened by clicking the card).
      const cards = events.map(event => {
        const tags = event.tags || [];
        const name = getTag(tags, 'name', 'Untitled');
        const summary = getTag(tags, 'summary');
        const icon = getTag(tags, 'icon');
        const description = event.content || '';
        const images = tags
          .filter(t => t[0] === 'image')
          .map(t => t[1] || '')
          .filter(Boolean);
        const identifier = getTag(tags, 'd');
        const naddr = encodeNaddr({
          kind: 32267,
          pubkey: event.pubkey,
          identifier,
          relays: ['wss://relay.zapstore.dev'],
        });

        const iconHtml = icon
          ? `<img class="profile-zapstore-app__icon" src="${escapeHtmlAttr(icon)}" alt="" loading="lazy" />`
          : '';
        const shotsHtml = images.length
          ? `<div class="profile-zapstore-app__shots">${images.map(img => `<img src="${escapeHtmlAttr(img)}" alt="" loading="lazy" />`).join('')}</div>`
          : '';

        return `
          <div class="profile-zapstore-app" data-route="/zapstore/${escapeHtmlAttr(naddr)}">
            <div class="profile-zapstore-app__header">
              ${iconHtml}
              <div class="profile-zapstore-app__id">
                <span class="profile-zapstore-app__name">${escapeHtml(name)}</span>
                ${summary ? `<span class="profile-zapstore-app__summary">${escapeHtml(summary)}</span>` : ''}
              </div>
            </div>
            ${description ? `<p class="profile-zapstore-app__desc">${escapeHtml(description)}</p>` : ''}
            ${shotsHtml}
          </div>
        `;
      });

      mount.innerHTML = `<div class="profile-zapstore-apps">${cards.join('')}</div>`;

      // Click handlers for internal navigation
      const { Router } = await import('../../services/Router');
      mount.querySelectorAll('.profile-zapstore-app').forEach(card => {
        card.addEventListener('click', () => {
          const route = (card as HTMLElement).dataset.route;
          if (route) Router.getInstance().navigate(route);
        });
      });
    } catch (error) {
      diagLog('system', 'ZapstoreApps: fetch failed', {
        pubkey: this.pubkey.slice(0, 8),
        error: String(error),
      });
    }
  }

  /**
   * Save view state (implements View base class)
   */
  public override saveState(): void {
    // Delegate to the inner timeline — it owns the correct scroll container
    // (.primary-content for ProfileView) via its ScrollPositionManager.
    this.timeline?.saveState();
  }

  /**
   * Restore view state (implements View base class)
   */
  public override restoreState(): void {
    this.timeline?.restoreState();
  }

  /**
   * Setup profile blinking on initial render
   */
  private setupProfileBlinking(displayName: string, picture: string): void {
    const avatar = this.container.querySelector(
      '.profile-pic--big'
    ) as HTMLImageElement;
    const nameEl = this.container.querySelector('.profile-name') as HTMLElement;
    if (!avatar || !nameEl) return;

    this.updateProfileWithBlinking(avatar, nameEl, displayName, picture);
  }

  /**
   * Update avatar and name with blinking logic (for both initial and subsequent renders)
   */
  private updateProfileWithBlinking(
    avatar: HTMLImageElement,
    nameEl: HTMLElement,
    currentName: string,
    currentPicture: string
  ): void {
    // Don't apply profile recognition to your own profile
    if (this.authService.isCurrentUser(this.pubkey)) {
      avatar.src = currentPicture;
      this.setNamePreservingPetname(nameEl, currentName);
      return;
    }

    const rt = this.getRecognitionRuntime();
    const encounter = rt?.service?.getEncounter(this.pubkey);

    // Check if we need to update lastKnown metadata
    if (
      encounter &&
      (currentPicture !== encounter.lastKnownPictureUrl ||
        currentName !== encounter.lastKnownName)
    ) {
      rt?.service?.updateLastKnown(this.pubkey, currentName, currentPicture);
    }

    // Determine if blinking should be active
    const shouldBlink =
      encounter && rt?.service?.hasChangedWithinWindow(this.pubkey);

    // Update avatar with blinking
    if (shouldBlink && encounter) {
      // Start avatar blinking
      if (!this.blinker && rt?.ProfileBlinker) {
        this.blinker = new rt.ProfileBlinker(avatar);
      }
      if (this.blinker && !this.blinker.isBlinking()) {
        this.blinker.start(currentPicture, encounter.firstPictureUrl);
      }
    } else {
      // Stop blinking or just set image
      if (this.blinker && this.blinker.isBlinking()) {
        this.blinker.stop(currentPicture);
      } else {
        avatar.src = currentPicture;
      }
    }

    // Update name with blinking
    if (shouldBlink && encounter) {
      // Start name blinking
      if (!this.nameBlinker && rt?.TextBlinker) {
        this.nameBlinker = new rt.TextBlinker(nameEl);
      }
      if (this.nameBlinker && !this.nameBlinker.isBlinking()) {
        this.nameBlinker.start(currentName, encounter.firstName);
      }
    } else {
      // Stop blinking or just set text
      if (this.nameBlinker && this.nameBlinker.isBlinking()) {
        this.nameBlinker.stop(currentName);
      } else {
        this.setNamePreservingPetname(nameEl, currentName);
      }
    }
  }

  private setNamePreservingPetname(nameEl: HTMLElement, name: string): void {
    const petnameSpan = nameEl.querySelector('[data-role="petname"]');
    const noteSpan = nameEl.querySelector('[data-role="petname-note"]');
    nameEl.textContent = name;
    if (petnameSpan) nameEl.appendChild(petnameSpan);
    if (noteSpan) nameEl.appendChild(noteSpan);
  }

  /**
   * Get the npub for this profile
   */
  public getNpub(): string {
    return this.npub;
  }

  /**
   * Get the profile view element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup resources (implements View base class)
   */
  public destroy(): void {
    // Detach header icon tooltips
    this.tooltipDisposers.forEach(dispose => dispose());
    this.tooltipDisposers = [];

    // Cleanup profile subscription
    this.profileUnsubscribe?.();
    this.profileUnsubscribe = null;

    // Cleanup TypedEventBus subscriptions
    this.eventBusSubscriptions.forEach(id => this.eventBus.off(id));
    this.eventBusSubscriptions = [];

    if (this.blinker) {
      this.blinker.destroy();
      this.blinker = null;
    }
    if (this.nameBlinker) {
      this.nameBlinker.destroy();
      this.nameBlinker = null;
    }
    this.cleanupTribeDropdown();
    if (this.timeline) {
      this.timeline.destroy();
    }
    if (this.searchComponent) {
      this.searchComponent.destroy();
    }
    if (this.profileListsComponent) {
      this.profileListsComponent.destroy();
    }
    if (this.articlesCarousel) {
      this.articlesCarousel.destroy();
    }
    if (this.videosCarousel) {
      this.videosCarousel.destroy();
    }
    if (this.listingsCarousel) {
      this.listingsCarousel.destroy();
      this.listingsCarousel = null;
    }
    for (const observer of this.carouselObservers) observer.disconnect();
    this.carouselObservers = [];
    this.container.remove();
  }
}
