/**
 * ProfileView Component
 * Displays user profile (NIP-01 + NIP-24) with user timeline
 * Timeline is rendered using TimelineUI component with author filter
 * Includes profile search functionality (results in GlobalSearchView)
 */

import { View } from './View';
import { UserProfileService, type UserProfile } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { UserService } from '../../services/UserService';
import { Timeline } from '../timeline/Timeline';
import { ProfileSearchComponent } from '../profile/ProfileSearchComponent';
import { ProfileFollowManager } from '../../lists/follows';
import { ProfileMuteManager } from '../../lists/mutes';
import { ProfileEditModal } from '../profile/ProfileEditModal';
import { AppState } from '../../services/AppState';
import { QRCodeModal } from '../qrcode/QRCodeModal';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { linkifyUrls } from '../../helpers/linkifyUrls';
import { convertLineBreaks } from '../../helpers/convertLineBreaks';
import { ClipboardActionsService } from '../../services/ClipboardActionsService';
import { EventBus } from '../../services/EventBus';
import { AuthGuard } from '../../services/AuthGuard';
import { ArticleNotificationService } from '../../services/ArticleNotificationService';
import { ProfileListsComponent } from '../profile/ProfileListsComponent';
import { ProfileArticlesCarousel } from '../profile/ProfileArticlesCarousel';
import { FollowerCountService } from '../../services/FollowerCountService';
import { isProfileRecognitionEnabled } from '../../addons/profile-recognition/index';

// Lazy-loaded types for profile recognition
type ProfileRecognitionServiceType = import('../../addons/profile-recognition/ProfileRecognitionService').ProfileRecognitionService;
type ProfileBlinkerType = import('../../addons/profile-recognition/profileBlinking').ProfileBlinker;
type TextBlinkerType = import('../../addons/profile-recognition/profileBlinking').TextBlinker;
import { ProfileOrchestrator } from '../../services/orchestration/ProfileOrchestrator';
import dayjs from 'dayjs';
import calendarSystems from '@calidy/dayjs-calendarsystems';
import HijriCalendarSystem from '@calidy/dayjs-calendarsystems/calendarSystems/HijriCalendarSystem';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { CustomDropdown } from '../ui/CustomDropdown';
import { ToastService } from '../../services/ToastService';
import * as tribes from '../../lists/tribes';
import { HIJRI_MONTHS } from '../../helpers/formatTimestamp';

// Initialize dayjs calendar system
dayjs.extend(calendarSystems);
dayjs.registerCalendarSystem('hijri' as any, new HijriCalendarSystem());

// Shared promise map to prevent duplicate profile loads on rapid navigation
type ProfileLoadResult = {
  profile: UserProfile;
  following: string[];
};
const loadingProfiles: Map<string, Promise<ProfileLoadResult>> = new Map();

export class ProfileView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private userService: UserService;
  private appState: AppState;
  private eventBus: EventBus;
  private timeline: Timeline | null = null;
  private followingCount: number = 0;
  private followerCount: number = 0;
  private isLoadingFollowers: boolean = false;
  private joinedDate: string | null = null;
  private isLoadingJoinedDate: boolean = false;
  private followsYou: boolean = false;
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

  // Services
  private followerCountService: FollowerCountService;
  private profileOrchestrator: ProfileOrchestrator;

  // Profile recognition (lazy-loaded)
  private recognitionService: ProfileRecognitionServiceType | null = null;
  private blinker: ProfileBlinkerType | null = null;
  private nameBlinker: TextBlinkerType | null = null;
  private ProfileBlinkerClass: (new (el: HTMLImageElement) => ProfileBlinkerType) | null = null;
  private TextBlinkerClass: (new (el: HTMLElement) => TextBlinkerType) | null = null;

  // Tribe dropdown
  private tribeDropdown: CustomDropdown | null = null;
  private tribeDropdownCleanupHandlers: Array<(e: MouseEvent | KeyboardEvent) => void> = [];

  // EventBus subscription IDs for cleanup
  private eventBusSubscriptions: string[] = [];

  constructor(npub: string) {
    super(); // Call View base class constructor
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--profile';
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.userService = UserService.getInstance();
    this.appState = AppState.getInstance();
    this.eventBus = EventBus.getInstance();
    this.followerCountService = FollowerCountService.getInstance();
    this.profileOrchestrator = ProfileOrchestrator.getInstance();
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

    // Load recognition addon before rendering to avoid race condition
    this.initAsync();
  }

  /** Load recognition addon first, then render */
  private async initAsync(): Promise<void> {
    if (isProfileRecognitionEnabled()) {
      const [{ ProfileRecognitionService }, { ProfileBlinker, TextBlinker }] = await Promise.all([
        import('../../addons/profile-recognition/ProfileRecognitionService'),
        import('../../addons/profile-recognition/profileBlinking')
      ]);

      this.recognitionService = ProfileRecognitionService.getInstance();
      this.ProfileBlinkerClass = ProfileBlinker;
      this.TextBlinkerClass = TextBlinker;
    }

    this.render();
  }

  /**
   * Setup listener for profile updates (after save in ProfileEditModal)
   */
  private setupProfileUpdateListener(): void {
    const id = this.eventBus.on('profile:updated', (data: { pubkey: string }) => {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser && data.pubkey === currentUser.pubkey && this.pubkey === currentUser.pubkey) {
        // Reload own profile after edit
        this.refreshProfile();
      }
    });
    this.eventBusSubscriptions.push(id);
  }

  /**
   * Setup listener for user switches (reload profile view to update Edit button visibility)
   */
  private setupUserSwitchListener(): void {
    const id = this.eventBus.on('user:login', () => {
      // Reset initial render flag and re-render to update Edit Profile button visibility
      this.isInitialRender = true;
      this.render();
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
        this.loadJoinedDate();
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
        this.render();
      }
    });
    this.eventBusSubscriptions.push(id);
  }

  /**
   * Setup listener for follow changes (re-render if this profile's follow status changed)
   */
  private setupFollowChangeListener(): void {
    const id = this.eventBus.on('follow:updated', async () => {
      // Only re-render if this profile's follow status actually changed
      const wasFollowing = this.lastKnownFollowStatus;
      const isFollowing = await this.followManager.checkFollowStatus();

      if (wasFollowing !== isFollowing) {
        this.lastKnownFollowStatus = isFollowing;
        this.isInitialRender = true;
        this.render();
      }
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
      const { profile, following } = await this.getProfileData();

      this.followingCount = following.length;

      // Check follow relationships (only for other profiles when logged in)
      if (currentUser && this.pubkey !== currentUser.pubkey) {
        this.followsYou = following.includes(currentUser.pubkey);
        const isFollowing = await this.followManager.checkFollowStatus();
        this.lastKnownFollowStatus = isFollowing;
      }

      // Render profile header
      this.renderProfileHeader(profile);

      // Load follower count (async, non-blocking)
      this.loadFollowerCount();

      // Load joined date (async, non-blocking)
      this.loadJoinedDate();

      // Subscribe to profile updates for live avatar/name updates
      this.userProfileService.subscribeToProfile(this.pubkey, (updatedProfile) => {
        this.renderProfileHeader(updatedProfile);
      });

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
      const count = await this.followerCountService.getFollowerCount(
        this.pubkey,
        (currentCount, _relay) => {
          // Update UI after each relay
          this.followerCount = currentCount;
          this.updateFollowerDisplay();
        }
      );
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
        followerEl.textContent = this.followerCount > 0 ? `${this.followerCount.toLocaleString('en-US')}+` : '...';
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
      const oldestTimestamp = await this.profileOrchestrator.fetchOldestEvent(this.pubkey);

      if (oldestTimestamp) {
        // Format date based on calendar system setting
        const date = new Date(oldestTimestamp * 1000);
        const storage = PerAccountLocalStorage.getInstance();
        const calendarSystem = storage.get<string>(StorageKeys.CALENDAR_SYSTEM, 'gregorian');

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
      const [profile, following] = await Promise.all([
        this.userProfileService.getUserProfile(this.pubkey),
        this.userService.getUserFollowing(this.pubkey)
      ]);

      return { profile, following };
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
    const displayName = profile.display_name || profile.name || 'Anonymous';
    const about = profile.about || '';
    const website = profile.website || '';
    const banner = profile.banner || '';
    const picture = profile.picture || this.userProfileService.getProfilePicture(this.pubkey) || '';
    // Multiple NIP-05: prefer nip05s from tags, fallback to single nip05 from content
    const nip05s = profile.nip05s && profile.nip05s.length > 0
      ? profile.nip05s
      : (profile.nip05 ? [profile.nip05] : []);
    const lud16 = profile.lud16 || '';


    // Process about text: escape HTML, convert line breaks, linkify URLs
    const processedAbout = about ? linkifyUrls(convertLineBreaks(this.escapeHtml(about))) : '';

    // Shorten npub for display (first 8 + last 6 chars)
    const shortNpub = `${this.npub.slice(0, 12)}...${this.npub.slice(-6)}`;

    const headerHTML = `
      <div class="profile-header">
        ${banner ? `
          <div class="profile-banner" style="background-image: url('${this.escapeHtml(banner)}')"></div>
        ` : `
          <div class="profile-banner profile-banner-fallback"></div>
        `}
        <div class="profile-search-mount"></div>

        <div class="profile-info">
          <div class="profile-avatar-wrapper">
            <img src="${this.escapeHtml(picture)}" alt="${this.escapeHtml(displayName)}" class="profile-pic profile-pic--big" />
            ${this.followsYou ? '<div class="follows-you-badge">Follows you</div>' : ''}
          </div>

          <div class="profile-meta">
            <h1 class="profile-name">${this.escapeHtml(displayName)}</h1>
            ${nip05s.length > 0 ? `<p class="profile-nip05">${nip05s.map(n => this.escapeHtml(n)).join(', ')}</p>` : ''}

            <div class="profile-identifiers">
              ${lud16 ? `
                <div class="profile-lightning">
                  <svg class="lightning-icon" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>
                  </svg>
                  <span>${this.escapeHtml(lud16)}</span>
                </div>
              ` : ''}

              <div class="profile-npub">
                <span class="npub-text" title="${this.escapeHtml(this.npub)}">${shortNpub}</span>
                <button class="copy-btn" data-copy="${this.escapeHtml(this.npub)}" title="Copy npub">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
                <button class="qr-btn" title="Show QR Code">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="7" height="7"></rect>
                    <rect x="14" y="3" width="7" height="7"></rect>
                    <rect x="14" y="14" width="7" height="7"></rect>
                    <rect x="3" y="14" width="7" height="7"></rect>
                  </svg>
                </button>
                ${this.renderTribeButton()}
                <span class="copy-feedback">Copied!</span>
              </div>
            </div>

            <div class="profile-joined-date" id="profile-joined-date"></div>

            ${processedAbout ? `<p class="profile-about">${processedAbout}</p>` : ''}
            ${website ? `<p class="profile-website"><a href="${this.escapeHtml(website)}" rel="noopener noreferrer">${this.escapeHtml(website)}</a></p>` : ''}

            <div class="profile-stats">
              ${this.renderEditButton()}
              ${this.renderFollowButton()}
              <div class="stat-item stat-item--clickable" id="following-count-link">
                <strong>${this.followingCount.toLocaleString('en-US')}</strong>
                <span>Following</span>
              </div>
              <div class="stat-item">
                <strong id="followers-count">${this.followerCount ? this.followerCount.toLocaleString('en-US') : '...'}</strong>
                <span>Followers</span>
              </div>
              ${this.renderMuteButton()}
            </div>
          </div>
        </div>

        <div class="profile-lists-mount"></div>
      </div>

      <div class="profile-articles-mount"></div>
      <div class="profile-timeline-container"></div>
    `;

    // Only use innerHTML on first render to avoid destroying mounted timeline
    if (this.isInitialRender) {
      this.container.innerHTML = headerHTML;
      this.isInitialRender = false;

      // Setup copy button handlers
      this.setupCopyButtons();

      // Load profile lists (mounted bookmark folders)
      this.loadProfileLists();

      // Load articles carousel
      this.loadArticlesCarousel();

      // Setup QR code button handler
      this.setupQRButton();

      // Setup tribe button handler
      this.setupTribeButton();

      // Setup edit button handler
      this.setupEditButton();

      // Setup follow button handler
      this.setupFollowButton();

      // Setup profile image click handler (zoom to full size)
      this.setupProfileImageClick(picture, banner);

      // Setup profile blinking (initial render)
      this.setupProfileBlinking(displayName, picture);
    } else {
      // On subsequent renders (profile updates), only update dynamic parts without destroying timeline

      // Update avatar and name with blinking logic
      const avatar = this.container.querySelector('.profile-pic--big') as HTMLImageElement;
      const nameEl = this.container.querySelector('.profile-name') as HTMLElement;
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
      const bannerEl = this.container.querySelector('.profile-banner') as HTMLElement;
      if (bannerEl && banner) {
        bannerEl.style.backgroundImage = `url('${banner}')`;
        bannerEl.classList.remove('profile-banner-fallback');
      }
    }

    // Setup mute button handler
    this.setupMuteButton();

    // Setup following count click handler
    this.setupFollowingCountLink();
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
      EventBus.getInstance().emit('list:open', {
        listType: 'follows',
        pubkey: this.pubkey
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
      <button class="edit-profile-btn" data-action="edit-profile" title="Edit your profile">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
        Edit Profile
      </button>
    `;
  }

  /**
   * Setup edit profile button event handler
   */
  private setupEditButton(): void {
    const editBtn = this.container.querySelector('[data-action="edit-profile"]');
    if (!editBtn) return;

    editBtn.addEventListener('click', async () => {
      // Check authentication with AuthGuard
      const isAuthenticated = AuthGuard.requireAuth('edit profile');
      if (!isAuthenticated) return;

      // Open profile edit modal
      const profileEditModal = ProfileEditModal.getInstance();
      profileEditModal.show();
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
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser || this.pubkey === currentUser.pubkey) {
      return muteButton;
    }

    const articleNotifService = ArticleNotificationService.getInstance();
    const isSubscribed = articleNotifService.isSubscribed(this.pubkey);

    const articleNotifCheckbox = `
      <label class="article-notif-checkbox" title="Get notified when this user posts a new article">
        <input type="checkbox" id="article-notif-toggle" ${isSubscribed ? 'checked' : ''} />
        <span>Article alerts</span>
      </label>
    `;

    return muteButton + articleNotifCheckbox;
  }

  /**
   * Render Tribe button (only if logged in and not own profile)
   */
  private renderTribeButton(): string {
    const currentUser = this.authService.getCurrentUser();

    // Don't show if not logged in
    if (!currentUser) {
      return '';
    }

    // Don't show on own profile
    if (currentUser.pubkey === this.pubkey) {
      return '';
    }

    return `
      <button class="tribe-btn" title="Add to Tribe">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="1.5"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="tribe-dropdown-mount"></div>
    `;
  }

  /**
   * Setup follow button event handler
   */
  private setupFollowButton(): void {
    this.followManager.setupFollowButton(this.container, () => {
      // Re-render button section when follow state changes
      const profileStats = this.container.querySelector('.profile-stats');
      if (profileStats) {
        const existingButton = profileStats.querySelector('.follow-btn, .follow-dropdown-container');
        if (existingButton) {
          existingButton.remove();
        }
        const followingCountLink = profileStats.querySelector('#following-count-link');
        if (followingCountLink) {
          followingCountLink.insertAdjacentHTML('beforebegin', this.renderFollowButton());
        }
        this.setupFollowButton();
      }
    });
  }

  /**
   * Setup mute button event handler
   */
  private setupMuteButton(): void {
    this.muteManager.setupMuteButton(this.container, () => {
      // Force full re-render (mute state changes HTML structure completely)
      this.isInitialRender = true;
      this.render();
    });

    // Setup article notification checkbox handler
    const articleNotifCheckbox = this.container.querySelector('#article-notif-toggle') as HTMLInputElement;
    if (articleNotifCheckbox) {
      articleNotifCheckbox.addEventListener('change', () => {
        const articleNotifService = ArticleNotificationService.getInstance();
        articleNotifService.toggle(this.pubkey);
      });
    }
  }


  /**
   * Setup copy button event handlers
   */
  private setupCopyButtons(): void {
    const clipboardService = ClipboardActionsService.getInstance();
    const copyButtons = this.container.querySelectorAll('.copy-btn');

    copyButtons.forEach(button => {
      button.addEventListener('click', async (e) => {
        e.preventDefault();
        const textToCopy = (button as HTMLElement).dataset.copy;
        if (textToCopy) {
          const success = await clipboardService.copyText(textToCopy, 'ID', true);
          if (success) {
            clipboardService.addVisualFeedback(button as HTMLElement);
          }
        }
      });
    });
  }

  /**
   * Setup QR code button event handler
   */
  private setupQRButton(): void {
    const qrButton = this.container.querySelector('.qr-btn');
    if (qrButton) {
      qrButton.addEventListener('click', (e) => {
        e.preventDefault();
        const qrModal = QRCodeModal.getInstance();
        qrModal.show(this.npub);
      });
    }
  }

  /**
   * Setup tribe button event handler
   */
  private setupTribeButton(): void {
    const tribeButton = this.container.querySelector('.tribe-btn');
    if (!tribeButton) return;

    tribeButton.addEventListener('click', async (e) => {
      e.preventDefault();

      // Check authentication
      const isAuthenticated = AuthGuard.requireAuth('add to tribe');
      if (!isAuthenticated) return;

      // Get all tribes
      const tribeFolders = tribes.getFolders();

      if (tribeFolders.length === 0) {
        ToastService.show('No tribes found. Create a tribe first in the Tribe view.', 'info');
        return;
      }

      // Build dropdown options with placeholder first
      const options = [
        { value: '', label: 'Choose a tribe' },
        ...tribeFolders.map(folder => ({
          value: folder.id,
          label: folder.name
        }))
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
      options: options,
      selectedValue: '',
      onChange: (folderId) => {
        // Close dropdown if placeholder selected
        if (!folderId) {
          this.cleanupTribeDropdown();
          return;
        }
        this.handleTribeSelection(folderId);
      },
      className: 'tribe-dropdown',
      width: '200px'
    });

    // Mount dropdown
    dropdownMount.appendChild(this.tribeDropdown.getElement());

    // Auto-open dropdown
    const trigger = this.tribeDropdown.getElement().querySelector('.custom-dropdown__trigger') as HTMLElement;
    if (trigger) {
      trigger.click();
    }

    // Cleanup dropdown when clicking outside or ESC
    const cleanupHandler = (e: MouseEvent | KeyboardEvent) => {
      const dropdownEl = this.tribeDropdown?.getElement();
      if (!dropdownEl) return;

      const isClickOutside = e instanceof MouseEvent && !dropdownEl.contains(e.target as Node);
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
      // Get folder details
      const folder = tribes.getFolder(folderId);
      if (!folder) {
        ToastService.show('Tribe not found', 'error');
        return;
      }

      // Check if user is already in THIS specific tribe
      const allMembers = tribes.getMembers();
      const isInThisTribe = allMembers.some(m => m.pubkey === this.pubkey && m.category === folder.name);

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
    const timelineContainer = this.container.querySelector('.profile-timeline-container');
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

      // Create TimelineUI with author filter (second param = show only this author's notes)
      this.timeline = new Timeline(userPubkey, this.pubkey);

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
        <p>❌ ${this.escapeHtml(message)}</p>
      </div>
    `;
  }

  /**
   * Show muted profile placeholder with unmute options
   */
  private async showMutedProfile(): Promise<void> {
    this.container.innerHTML = await this.muteManager.renderMutedProfile(this.escapeHtml.bind(this));
    this.muteManager.setupUnmuteButton(this.container, () => {
      // Reload profile after unmute
      this.render();
    });
  }


  /**
   * Initialize search component
   */
  private initializeSearchComponent(): void {
    // Create search component (emits globalSearch:start event)
    this.searchComponent = new ProfileSearchComponent(this.pubkey);

    // Mount search component in header
    const searchMount = this.container.querySelector('.profile-search-mount');
    if (searchMount && this.searchComponent) {
      searchMount.appendChild(this.searchComponent.getElement());
    }
  }

  /**
   * Load profile lists (mounted bookmark folders)
   */
  private async loadProfileLists(): Promise<void> {
    const listsMount = this.container.querySelector('.profile-lists-mount');
    if (!listsMount) return;

    // Create and render profile lists component
    this.profileListsComponent = new ProfileListsComponent(this.pubkey);
    const element = await this.profileListsComponent.render();
    listsMount.appendChild(element);
  }

  /**
   * Load articles carousel (user's long-form articles)
   */
  private async loadArticlesCarousel(): Promise<void> {
    const articlesMount = this.container.querySelector('.profile-articles-mount');
    if (!articlesMount) return;

    // Create and render articles carousel
    this.articlesCarousel = new ProfileArticlesCarousel(this.pubkey);
    const element = await this.articlesCarousel.render();
    articlesMount.appendChild(element);
  }

  /**
   * Save view state (implements View base class)
   */
  public override saveState(): void {
    const position = this.container.scrollTop;
    this.appState.setState('view', { profileScrollPosition: position });
  }

  /**
   * Restore view state (implements View base class)
   */
  public override restoreState(): void {
    const savedPosition = this.appState.getState('view').profileScrollPosition;
    if (savedPosition !== undefined && savedPosition !== null) {
      // Use setTimeout to ensure DOM is fully rendered before scrolling
      setTimeout(() => {
        this.container.scrollTop = savedPosition;
      }, 0);
    }
  }

  /**
   * Setup profile blinking on initial render
   */
  private setupProfileBlinking(displayName: string, picture: string): void {
    const avatar = this.container.querySelector('.profile-pic--big') as HTMLImageElement;
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
    const currentUser = this.authService.getCurrentUser();
    if (currentUser && currentUser.pubkey === this.pubkey) {
      // Just set the image and name directly
      avatar.src = currentPicture;
      nameEl.textContent = currentName;
      return;
    }

    const encounter = this.recognitionService?.getEncounter(this.pubkey);

    // Check if we need to update lastKnown metadata
    if (encounter && (currentPicture !== encounter.lastKnownPictureUrl || currentName !== encounter.lastKnownName)) {
      this.recognitionService?.updateLastKnown(this.pubkey, currentName, currentPicture);
    }

    // Determine if blinking should be active
    const shouldBlink = encounter && this.recognitionService?.hasChangedWithinWindow(this.pubkey);

    // Update avatar with blinking
    if (shouldBlink && encounter) {
      // Start avatar blinking
      if (!this.blinker && this.ProfileBlinkerClass) {
        this.blinker = new this.ProfileBlinkerClass(avatar);
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
      if (!this.nameBlinker && this.TextBlinkerClass) {
        this.nameBlinker = new this.TextBlinkerClass(nameEl);
      }
      if (this.nameBlinker && !this.nameBlinker.isBlinking()) {
        this.nameBlinker.start(currentName, encounter.firstName);
      }
    } else {
      // Stop blinking or just set text
      if (this.nameBlinker && this.nameBlinker.isBlinking()) {
        this.nameBlinker.stop(currentName);
      } else {
        nameEl.textContent = currentName;
      }
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
    // Cleanup EventBus subscriptions
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
    this.container.remove();
  }
}
