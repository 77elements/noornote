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

import {
  UserProfileService,
  UserProfile,
} from '../../services/UserProfileService';
import { UserHoverCard } from '../ui/UserHoverCard';
import { AddonLoader } from '../../addons/AddonLoader';
import type { ProfileRecognitionRuntime } from '../../addons/profile-recognition/runtime';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { hexToNpub } from '../../helpers/nip19';
import { PetnameService } from '../../services/PetnameService';

// Types only (erased at build time) — live runtime accessed via AddonLoader
type ProfileBlinkerType =
  import('../../addons/profile-recognition/profileBlinking').ProfileBlinker;
type TextBlinkerType =
  import('../../addons/profile-recognition/profileBlinking').TextBlinker;

export interface UserIdentityConfig {
  pubkey: string;
  size?: 'small' | 'medium' | 'large'; // Avatar size
  showAvatar?: boolean; // Default: true
  showUsername?: boolean; // Default: true
  showHandle?: boolean; // Default: false - show NIP-05 handle
  inline?: boolean; // Default: false - lay avatar + name/handle on one baseline row (note headers)
  relayHints?: string[]; // Default: [] - relays to try first for this profile (e.g. the reposter's write relays)
  enableHoverCard?: boolean; // Default: true - show user hover card on hover
  clickable?: boolean; // Default: false - click navigates to profile
  onClick?: (pubkey: string) => void; // Custom click handler (overrides default navigation)
}

export class UserIdentity {
  private element: HTMLElement;
  private config: Required<Omit<UserIdentityConfig, 'onClick'>> &
    Pick<UserIdentityConfig, 'onClick'>;
  private userProfileService: UserProfileService;
  private profile: UserProfile | null = null;
  private unsubscribe?: () => void;

  // Profile Recognition blinker instances — bound to this component's DOM.
  // The service + blinker classes live in the addon runtime, looked up
  // fresh via AddonLoader at use time.
  private blinker: ProfileBlinkerType | null = null;
  private nameBlinker: TextBlinkerType | null = null;

  constructor(config: UserIdentityConfig) {
    this.config = {
      size: 'medium',
      showAvatar: true,
      showUsername: true,
      showHandle: false,
      inline: false,
      relayHints: [],
      enableHoverCard: true,
      clickable: false,
      ...config,
    };

    this.userProfileService = UserProfileService.getInstance();

    this.element = this.createElement();
    // Element is hidden until first profile arrives (below). No async
    // addon-load race anymore — AddonLoader owns the profile-recognition
    // runtime; we look it up on demand.
    this.element.style.display = 'none';
    this.subscribeToUpdates();

    // Setup hover card if enabled
    if (this.config.enableHoverCard) {
      this.setupHoverCard();
    }

    // Setup click handler if clickable
    if (this.config.clickable) {
      this.setupClickHandler();
    }
  }

  /** Fetch the current profile-recognition runtime, or null if addon is OFF. */
  private getRecognitionRuntime(): ProfileRecognitionRuntime | null {
    return AddonLoader.getInstance().getRuntime<ProfileRecognitionRuntime>(
      'profile-recognition'
    );
  }

  /**
   * Create the identity element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    const classes = [`user-identity`, `user-identity--${this.config.size}`];
    if (this.config.inline) {
      classes.push('user-identity--inline');
    }
    if (this.config.clickable) {
      classes.push('user-identity--clickable');
    }
    container.className = classes.join(' ');

    if (this.config.showAvatar) {
      const avatar = document.createElement('img');
      avatar.className = 'profile-pic profile-pic--medium';
      avatar.alt = 'Avatar';
      avatar.loading = 'lazy';
      avatar.dataset.pubkey = this.config.pubkey; // for global 404 fallback
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
   * Subscribe to profile updates
   */
  private subscribeToUpdates(): void {
    this.unsubscribe = this.userProfileService.subscribeToProfile(
      this.config.pubkey,
      profile => {
        this.profile = profile;

        // Render-ready values from the cache (single source of truth: real
        // data when known, deterministic fallback otherwise — see UserProfileService).
        const username = UserProfileService.displayNameOf(
          profile,
          this.config.pubkey
        );
        const picture = UserProfileService.displayPictureOf(
          profile,
          this.config.pubkey
        );

        // Get NIP-05 handle(s)
        const nip05s =
          profile.nip05s && profile.nip05s.length > 0
            ? profile.nip05s
            : profile.nip05
              ? [profile.nip05]
              : [];
        const handle = nip05s.length > 0 ? nip05s.join(', ') : '';

        // Show element and update UI
        this.element.style.display = '';
        this.updateUI(username, picture, handle);
      },
      this.config.relayHints
    );
  }

  /**
   * Update UI with username, picture, and handle
   */
  private updateUI(username: string, picture: string, handle: string): void {
    // Profile Recognition: check if name/picture changed and should blink
    const rt = this.getRecognitionRuntime();
    const shouldBlink = rt?.service?.checkRecognition(
      this.config.pubkey,
      username,
      picture
    );

    // Update username with blinking
    if (this.config.showUsername) {
      const usernameEl = this.element.querySelector(
        '.user-identity__username'
      ) as HTMLElement;
      if (usernameEl) {
        if (shouldBlink) {
          // Initialize name blinker if needed
          if (!this.nameBlinker && rt?.TextBlinker) {
            this.nameBlinker = new rt.TextBlinker(usernameEl);
          }

          // Start blinking between current and first encounter
          if (this.nameBlinker && !this.nameBlinker.isBlinking()) {
            this.nameBlinker.start(username, shouldBlink.firstName);
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
      const avatarEl = this.element.querySelector(
        'img.profile-pic'
      ) as HTMLImageElement;
      if (avatarEl) {
        // Private petname ring (warning orange) — this pubkey has a private
        // note (NIP-78) and the feature is enabled. Rule order in _note-ui.scss
        // keeps red (muted) > orange > green (follows) on collision.
        avatarEl.classList.toggle(
          'author-rel--private-note',
          PetnameService.getInstance().hasPrivateNote(this.config.pubkey)
        );

        if (shouldBlink) {
          // Initialize blinker if needed
          if (!this.blinker && rt?.ProfileBlinker) {
            this.blinker = new rt.ProfileBlinker(avatarEl);
          }

          // Start blinking between current and first encounter
          if (this.blinker && !this.blinker.isBlinking()) {
            this.blinker.start(picture, shouldBlink.firstPictureUrl);
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
      const handleEl = this.element.querySelector(
        '.user-identity__handle'
      ) as HTMLElement;
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
    this.element.addEventListener('click', e => {
      e.stopPropagation(); // Prevent parent click handlers

      if (this.config.onClick) {
        this.config.onClick(this.config.pubkey);
      } else {
        // Default: navigate to profile. Route through the central controller so
        // right-pane mode opens the profile in the secondary pane (scc) instead of
        // navigating the timeline (pcc).
        const npub = hexToNpub(this.config.pubkey);
        if (npub) {
          getViewNavigationController().openView('profile', npub, e);
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
