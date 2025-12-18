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
import { ProfileFollowManager } from '../profile/ProfileFollowManager';
import { ProfileMuteManager } from '../profile/ProfileMuteManager';
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

// Shared promise map to prevent duplicate profile loads on rapid navigation
type ProfileLoadResult = {
  profile: UserProfile;
  following: string[];
  followEvent: any;
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
  private followsYou: boolean = false;
  private isInitialRender: boolean = true; // Track if this is first render

  // Managers
  private followManager: ProfileFollowManager;
  private muteManager: ProfileMuteManager;

  // Search component
  private searchComponent: ProfileSearchComponent | null = null;

  // Profile lists component (mounted bookmark folders)
  private profileListsComponent: ProfileListsComponent | null = null;

  // Articles carousel component
  private articlesCarousel: ProfileArticlesCarousel | null = null;

  constructor(npub: string) {
    super(); // Call View base class constructor
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'profile-view';
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.userService = UserService.getInstance();
    this.appState = AppState.getInstance();
    this.eventBus = EventBus.getInstance();

    // Decode npub to pubkey
    try {
      const decoded = decodeNip19(npub);
      if (decoded.type === 'npub') {
        this.pubkey = decoded.data;
      } else {
        throw new Error('Invalid npub');
      }
    } catch (_error) {
      console.error('❌ PV: Invalid npub', _error);
      this.pubkey = '';
    }

    // Initialize managers
    this.followManager = new ProfileFollowManager(this.pubkey);
    this.muteManager = new ProfileMuteManager(this.pubkey);

    // Listen for profile updates
    this.setupProfileUpdateListener();

    this.render();
  }

  /**
   * Setup listener for profile updates (after save in ProfileEditModal)
   */
  private setupProfileUpdateListener(): void {
    this.eventBus.on('profile:updated', (data: { pubkey: string }) => {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser && data.pubkey === currentUser.pubkey && this.pubkey === currentUser.pubkey) {
        // Reload own profile after edit
        this.refreshProfile();
      }
    });
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
        if (muteStatus.public || muteStatus.private) {
          // Show muted profile placeholder
          await this.showMutedProfile();
          return;
        }
      }

      // Fetch profile data (uses shared promise to prevent duplicate requests)
      const { profile, following } = await this.getProfileData();

      this.followingCount = following.length;

      // Check if this profile user follows the logged-in user
      if (currentUser && this.pubkey !== currentUser.pubkey) {
        this.followsYou = following.includes(currentUser.pubkey);
      }

      // Check if current user follows this profile
      if (currentUser && this.pubkey !== currentUser.pubkey) {
        await this.followManager.checkFollowStatus();
      }

      // Render profile header
      this.renderProfileHeader(profile);

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
   * Fetch profile data with shared promise to prevent duplicate requests
   */
  private async fetchProfileData(): Promise<ProfileLoadResult> {
    try {
      const [profile, following] = await Promise.all([
        this.userProfileService.getUserProfile(this.pubkey),
        this.userService.getUserFollowing(this.pubkey)
      ]);

      return {
        profile,
        following,
        followEvent: null
      };
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
    const picture = profile.picture || this.userProfileService.getProfilePicture(this.pubkey);
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
                <span class="copy-feedback">Copied!</span>
              </div>
            </div>

            ${processedAbout ? `<p class="profile-about">${processedAbout}</p>` : ''}
            ${website ? `<p class="profile-website"><a href="${this.escapeHtml(website)}" rel="noopener noreferrer">${this.escapeHtml(website)}</a></p>` : ''}

            <div class="profile-stats">
              ${this.renderEditButton()}
              ${this.renderFollowButton()}
              <div class="stat-item stat-item--clickable" id="following-count-link">
                <strong>${this.followingCount}</strong>
                <span>Following</span>
              </div>
              ${this.followsYou ? '<div class="follows-you-badge">Follows you</div>' : ''}
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

      // Setup edit button handler
      this.setupEditButton();

      // Setup follow button handler
      this.setupFollowButton();

      // Setup profile image click handler (zoom to full size)
      this.setupProfileImageClick(picture, banner);
    } else {
      // On subsequent renders (profile updates), only update dynamic parts without destroying timeline

      // Update avatar
      const avatar = this.container.querySelector('.profile-pic--big') as HTMLImageElement;
      if (avatar) avatar.src = picture;

      // Update display name
      const nameEl = this.container.querySelector('.profile-name');
      if (nameEl) nameEl.textContent = displayName;

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
      EventBus.getInstance().emit('list:open', { listType: 'follows' });
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
      const isAuthenticated = await AuthGuard.requireAuth();
      if (!isAuthenticated) return;

      // Open profile edit modal
      const profileEditModal = ProfileEditModal.getInstance();
      profileEditModal.show();
    });
  }

  /**
   * Render Connect/Disconnect button (only if logged in and not own profile)
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
    const authService = AuthService.getInstance();
    const currentUser = authService.getCurrentUser();

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
      // Reload profile to show muted state
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
    // ProfileView has its own scroll container (.profile-view)
    const position = this.container.scrollTop;
    console.log(`💾 ProfileView: Saving scroll position: ${position}px`);
    this.appState.setState('view', { profileScrollPosition: position });
  }

  /**
   * Restore view state (implements View base class)
   */
  public override restoreState(): void {
    // ProfileView has its own scroll container (.profile-view)
    const savedPosition = this.appState.getState('view').profileScrollPosition;

    console.log(`📜 ProfileView: Attempting to restore scroll position: ${savedPosition}px`);

    if (savedPosition !== undefined && savedPosition !== null) {
      // Use setTimeout to ensure DOM is fully rendered before scrolling
      setTimeout(() => {
        this.container.scrollTop = savedPosition;
        console.log(`✅ ProfileView: Scroll position restored to ${savedPosition}px`);
      }, 0);
    } else {
      console.log(`❌ ProfileView: Cannot restore scroll - position: ${savedPosition}`);
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
