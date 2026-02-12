/**
 * UserIdentity Component
 * Displays avatar + username + optional NIP-05 handle for a pubkey
 * Reusable molecule for notes, DMs, and anywhere user info is shown
 *
 * Fetch strategy (in order):
 * 1. localStorage (usernameCache/pictureCache) - instant
 * 2. profileCache - fast
 * 3. Bootstrap relays (user's standard relays) - normal fetch
 * 4. FALLBACK: User's outbound relays (NIP-65) - slow, only if all else fails
 *
 * Usage:
 * const identity = new UserIdentity({ pubkey, size: 'medium', showHandle: true, clickable: true });
 * container.appendChild(identity.getElement());
 */

import { UserProfileService, UserProfile } from '../../services/UserProfileService';
import { UserHoverCard } from '../ui/UserHoverCard';
import { ProfileRecognitionService } from '../../services/ProfileRecognitionService';
import { ProfileBlinker, TextBlinker } from '../../helpers/profileBlinking';
import { AuthService } from '../../services/AuthService';
import { Router } from '../../services/Router';
import { hexToNpub } from '../../helpers/nip19';

export interface UserIdentityConfig {
  pubkey: string;
  size?: 'small' | 'medium' | 'large'; // Avatar size
  showAvatar?: boolean; // Default: true
  showUsername?: boolean; // Default: true
  showHandle?: boolean; // Default: false - show NIP-05 handle
  enableHoverCard?: boolean; // Default: true - show user hover card on hover
  clickable?: boolean; // Default: false - click navigates to profile
  onClick?: (pubkey: string) => void; // Custom click handler (overrides default navigation)
}

export class UserIdentity {
  private element: HTMLElement;
  private config: Required<Omit<UserIdentityConfig, 'onClick'>> & Pick<UserIdentityConfig, 'onClick'>;
  private userProfileService: UserProfileService;
  private recognitionService: ProfileRecognitionService;
  private authService: AuthService;
  private router: Router;
  private profile: UserProfile | null = null;
  private unsubscribe?: () => void;
  private blinker: ProfileBlinker | null = null;
  private nameBlinker: TextBlinker | null = null;

  constructor(config: UserIdentityConfig) {
    this.config = {
      size: 'medium',
      showAvatar: true,
      showUsername: true,
      showHandle: false,
      enableHoverCard: true,
      clickable: false,
      ...config
    };

    this.userProfileService = UserProfileService.getInstance();
    this.recognitionService = ProfileRecognitionService.getInstance();
    this.authService = AuthService.getInstance();
    this.router = Router.getInstance();

    this.element = this.createElement();
    this.loadIdentity();

    // Setup hover card if enabled
    if (this.config.enableHoverCard) {
      this.setupHoverCard();
    }

    // Setup click handler if clickable
    if (this.config.clickable) {
      this.setupClickHandler();
    }
  }

  /**
   * Create the identity element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    const classes = [`user-identity`, `user-identity--${this.config.size}`];
    if (this.config.clickable) {
      classes.push('user-identity--clickable');
    }
    container.className = classes.join(' ');

    if (this.config.showAvatar) {
      const avatar = document.createElement('img');
      avatar.className = 'user-identity__avatar';
      avatar.alt = 'Avatar';
      avatar.loading = 'lazy';
      container.appendChild(avatar);
    }

    // Info container for username + handle
    if (this.config.showUsername || this.config.showHandle) {
      const info = document.createElement('div');
      info.className = 'user-identity__info';

      if (this.config.showUsername) {
        const username = document.createElement('h2');
        username.className = 'user-identity__username h4';
        username.textContent = '';
        info.appendChild(username);
      }

      if (this.config.showHandle) {
        const handle = document.createElement('span');
        handle.className = 'user-identity__handle';
        handle.textContent = '';
        info.appendChild(handle);
      }

      container.appendChild(info);
    }

    return container;
  }

  /**
   * Load identity - ONLY render when profile is loaded (like Jumble)
   */
  private async loadIdentity(): Promise<void> {
    // Hide element until profile loads (no cache)
    this.element.style.display = 'none';

    // Subscribe to updates so UI shows when real profile loads
    this.subscribeToUpdates();
  }

  /**
   * Subscribe to profile updates
   */
  private subscribeToUpdates(): void {
    this.unsubscribe = this.userProfileService.subscribeToProfile(
      this.config.pubkey,
      (profile) => {
        this.profile = profile;

        // Extract data from profile object
        const username = profile.display_name || profile.name || profile.username || 'Anon';
        const picture = profile.picture || '';

        // Get NIP-05 handle(s)
        const nip05s = profile.nip05s && profile.nip05s.length > 0
          ? profile.nip05s
          : (profile.nip05 ? [profile.nip05] : []);
        const handle = nip05s.length > 0 ? nip05s.join(', ') : '';

        // Show element and update UI
        this.element.style.display = '';
        this.updateUI(username, picture, handle);
      }
    );
  }

  /**
   * Update UI with username, picture, and handle
   */
  private updateUI(username: string, picture: string, handle: string): void {
    // Don't apply profile recognition to your own profile
    const currentUser = this.authService.getCurrentUser();
    const isOwnProfile = currentUser && currentUser.pubkey === this.config.pubkey;

    // Profile Recognition logic (shared between username and avatar)
    const encounter = this.recognitionService.getEncounter(this.config.pubkey);

    // Update last known metadata if changed
    if (encounter && (username !== encounter.lastKnownName || picture !== encounter.lastKnownPictureUrl)) {
      this.recognitionService.updateLastKnown(this.config.pubkey, username, picture);
    }

    // Check if should blink (but not for own profile)
    const shouldBlink = !isOwnProfile && encounter && this.recognitionService.hasChangedWithinWindow(this.config.pubkey);

    // Update username with blinking
    if (this.config.showUsername) {
      const usernameEl = this.element.querySelector('.user-identity__username') as HTMLElement;
      if (usernameEl) {
        if (shouldBlink && encounter) {
          // Initialize name blinker if needed
          if (!this.nameBlinker) {
            this.nameBlinker = new TextBlinker(usernameEl);
          }

          // Start blinking between current and first encounter
          if (!this.nameBlinker.isBlinking()) {
            this.nameBlinker.start(username, encounter.firstName);
          }
        } else {
          // Stop blinking and show current name
          if (this.nameBlinker && this.nameBlinker.isBlinking()) {
            this.nameBlinker.stop(username);
          } else {
            usernameEl.textContent = username;
          }
        }
      }
    }

    // Update avatar with blinking
    if (this.config.showAvatar) {
      const avatarEl = this.element.querySelector('.user-identity__avatar') as HTMLImageElement;
      if (avatarEl) {
        if (shouldBlink && encounter) {
          // Initialize blinker if needed
          if (!this.blinker) {
            this.blinker = new ProfileBlinker(avatarEl);
          }

          // Start blinking between current and first encounter
          if (!this.blinker.isBlinking()) {
            this.blinker.start(picture, encounter.firstPictureUrl);
          }
        } else {
          // Stop blinking and show current pic
          if (this.blinker && this.blinker.isBlinking()) {
            this.blinker.stop(picture);
          } else {
            avatarEl.src = picture;
          }
        }

        avatarEl.alt = username;
      }
    }

    // Update handle
    if (this.config.showHandle) {
      const handleEl = this.element.querySelector('.user-identity__handle') as HTMLElement;
      if (handleEl) {
        if (handle) {
          handleEl.textContent = handle;
          handleEl.style.display = '';
        } else {
          handleEl.style.display = 'none';
        }
      }
    }
  }

  /**
   * Setup hover card for this user identity
   */
  private setupHoverCard(): void {
    const userHoverCard = UserHoverCard.getInstance();

    this.element.addEventListener('mouseenter', () => {
      userHoverCard.show(this.config.pubkey, this.element);
    });

    this.element.addEventListener('mouseleave', () => {
      userHoverCard.hide();
    });
  }

  /**
   * Setup click handler for navigation to profile
   */
  private setupClickHandler(): void {
    this.element.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent parent click handlers

      if (this.config.onClick) {
        this.config.onClick(this.config.pubkey);
      } else {
        // Default: navigate to profile
        const npub = hexToNpub(this.config.pubkey);
        if (npub) {
          this.router.navigate(`/profile/${npub}`);
        }
      }
    });
  }

  /**
   * Get the DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Get the current profile (if loaded)
   */
  public getProfile(): UserProfile | null {
    return this.profile;
  }

  /**
   * Get the pubkey
   */
  public getPubkey(): string {
    return this.config.pubkey;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    if (this.blinker) {
      this.blinker.destroy();
      this.blinker = null;
    }
    if (this.nameBlinker) {
      this.nameBlinker.destroy();
      this.nameBlinker = null;
    }
  }
}
