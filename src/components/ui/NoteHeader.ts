/**
 * NoteHeader Component
 * Reusable note header with profile photo, username, verification, and timestamp
 * Container-width independent with flexible layout
 * Default behavior: Click on avatar/username navigates to profile page
 */

import { UserProfileService, UserProfile } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { hexToNpub } from '../../helpers/nip19';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { NoteMenu } from './NoteMenu';
import { UserHoverCard } from './UserHoverCard';
import { ProfileRecognitionService } from '../../services/ProfileRecognitionService';
import { ProfileBlinker, TextBlinker } from '../../helpers/profileBlinking';
import { AuthService } from '../../services/AuthService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface NoteHeaderOptions {
  pubkey: string;
  eventId: string;
  timestamp: number;
  rawEvent?: NostrEvent;
  showVerification?: boolean;
  showTimestamp?: boolean;
  showMenu?: boolean;
  onClick?: (pubkey: string) => void;
}

export class NoteHeader {
  private element: HTMLElement;
  private userProfileService: UserProfileService;
  private recognitionService: ProfileRecognitionService;
  private authService: AuthService;
  private options: Required<NoteHeaderOptions>;
  private profile: UserProfile | null = null;
  private unsubscribeProfile?: () => void;
  private noteMenu?: NoteMenu;
  private blinker: ProfileBlinker | null = null;
  private nameBlinker: TextBlinker | null = null;

  constructor(options: NoteHeaderOptions) {
    this.userProfileService = UserProfileService.getInstance();
    this.recognitionService = ProfileRecognitionService.getInstance();
    this.authService = AuthService.getInstance();

    // Default onClick: Navigate to profile page
    const defaultOnClick = (pubkey: string) => {
      const router = Router.getInstance();
      const npub = hexToNpub(pubkey);
      router.navigate(`/profile/${npub}`);
    };

    this.options = {
      showVerification: true,
      showTimestamp: true,
      showMenu: true,
      onClick: defaultOnClick,
      rawEvent: undefined,
      ...options
    };

    this.element = this.createElement();
    this.loadProfile();
  }

  /**
   * Create the note header element
   */
  private createElement(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'note-header note-header--clickable';
    header.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent parent note click handler
      this.options.onClick(this.options.pubkey);
    });

    // NO whitespace between tags - prevents invisible text nodes causing spacing issues
    // Note: Display name will be populated when profile loads
    header.innerHTML = `<div class="note-header__avatar"><img class="profile-pic profile-pic--medium" src="" alt="Avatar" loading="lazy" /></div><div class="note-header__info"><div class="note-header__primary-line"><span class="note-header__display-name"><span class="note-header__display-name-trigger"></span></span>${this.options.showVerification ? '<span class="note-header__verification" style="display: none;">✓</span>' : ''}${this.options.showTimestamp ? `<time class="note-header__timestamp">${formatTimestamp(this.options.timestamp)}</time>` : ''}${this.options.showMenu ? '<span class="note-header__menu-container"></span>' : ''}</div><div class="note-header__handle"></div></div>`;

    // User hover card - only on avatar and display name trigger
    const hoverCard = UserHoverCard.getInstance();
    const avatar = header.querySelector('.note-header__avatar');
    const displayNameTrigger = header.querySelector('.note-header__display-name-trigger');

    if (avatar) {
      avatar.addEventListener('mouseenter', () => {
        hoverCard.show(this.options.pubkey, header);
      });
      avatar.addEventListener('mouseleave', () => {
        hoverCard.hide();
      });
    }

    if (displayNameTrigger) {
      displayNameTrigger.addEventListener('mouseenter', () => {
        hoverCard.show(this.options.pubkey, header);
      });
      displayNameTrigger.addEventListener('mouseleave', () => {
        hoverCard.hide();
      });
    }

    // Create and mount NoteMenu if enabled
    if (this.options.showMenu) {
      this.noteMenu = new NoteMenu({
        eventId: this.options.eventId,
        authorPubkey: this.options.pubkey,
        rawEvent: this.options.rawEvent
      });

      const menuContainer = header.querySelector('.note-header__menu-container');
      if (menuContainer) {
        menuContainer.appendChild(this.noteMenu.getTrigger());
      }
    }

    return header;
  }

  /**
   * Load user profile and update display (reactive pattern like nostr-react)
   */
  private async loadProfile(): Promise<void> {
    // Hide header until profile loads (like Jumble)
    this.element.style.opacity = '0';
    this.element.style.pointerEvents = 'none';

    // Subscribe to profile updates (reactive like useProfile hook)
    this.unsubscribeProfile = this.userProfileService.subscribeToProfile(
      this.options.pubkey,
      (profile: UserProfile) => {
        this.profile = profile;
        this.updateDisplay();
        // Show header when profile loaded
        this.element.style.opacity = '1';
        this.element.style.pointerEvents = 'auto';
      }
    );

    // Trigger initial load
    try {
      await this.userProfileService.getUserProfile(this.options.pubkey);
    } catch (error) {
      console.warn(`Failed to load profile for note header: ${this.options.pubkey}`, error);
    }
  }

  /**
   * Update display with loaded profile
   */
  private updateDisplay(): void {
    if (!this.profile) return;

    // Extract display name from profile (no cache, direct from profile object)
    const displayName = this.profile.display_name || this.profile.name || this.profile.username || 'Anon';
    const picture = this.profile.picture || '';

    const avatarImg = this.element.querySelector('.profile-pic--medium') as HTMLImageElement;
    const displayNameTrigger = this.element.querySelector('.note-header__display-name-trigger') as HTMLElement;
    const handle = this.element.querySelector('.note-header__handle');
    const verification = this.element.querySelector('.note-header__verification');

    // Don't apply profile recognition to your own profile
    const currentUser = this.authService.getCurrentUser();
    const isOwnProfile = currentUser && currentUser.pubkey === this.options.pubkey;

    // Profile Recognition logic (shared)
    const encounter = this.recognitionService.getEncounter(this.options.pubkey);

    // Update last known metadata if changed
    if (encounter && (displayName !== encounter.lastKnownName || picture !== encounter.lastKnownPictureUrl)) {
      this.recognitionService.updateLastKnown(this.options.pubkey, displayName, picture);
    }

    // Check if should blink (but not for own profile)
    const shouldBlink = !isOwnProfile && encounter && this.recognitionService.hasChangedWithinWindow(this.options.pubkey);

    // Update avatar with blinking
    if (avatarImg) {
      if (shouldBlink && encounter) {
        // Initialize blinker if needed
        if (!this.blinker) {
          this.blinker = new ProfileBlinker(avatarImg);
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
          avatarImg.src = picture;
        }
      }

      avatarImg.alt = displayName;
    }

    // Update display name with blinking
    if (displayNameTrigger) {
      if (shouldBlink && encounter) {
        // Initialize name blinker if needed
        if (!this.nameBlinker) {
          this.nameBlinker = new TextBlinker(displayNameTrigger);
        }

        // Start blinking between current and first encounter
        if (!this.nameBlinker.isBlinking()) {
          this.nameBlinker.start(displayName, encounter.firstName);
        }
      } else {
        // Stop blinking and show current name
        if (this.nameBlinker && this.nameBlinker.isBlinking()) {
          this.nameBlinker.stop(displayName);
        } else {
          displayNameTrigger.textContent = displayName;
        }
      }
    }

    // Update handle with NIP-05(s) if available - prefer nip05s from tags
    if (handle) {
      const nip05s = this.profile.nip05s && this.profile.nip05s.length > 0
        ? this.profile.nip05s
        : (this.profile.nip05 ? [this.profile.nip05] : []);

      if (nip05s.length > 0) {
        handle.textContent = nip05s.join(', ');
        handle.style.display = 'block';
      } else {
        handle.style.display = 'none';
      }
    }

    // Update verification
    if (verification && this.options.showVerification) {
      if (this.userProfileService.isVerified(this.profile)) {
        const nip05sForTitle = this.profile.nip05s && this.profile.nip05s.length > 0
          ? this.profile.nip05s
          : (this.profile.nip05 ? [this.profile.nip05] : []);
        verification.style.display = 'inline-flex';
        verification.setAttribute('title', `Verified: ${nip05sForTitle.join(', ')}`);
      } else {
        verification.style.display = 'none';
      }
    }
  }


  /**
   * Update timestamp (for live updates)
   */
  public updateTimestamp(): void {
    const timestampEl = this.element.querySelector('.note-header__timestamp');
    if (timestampEl && this.options.showTimestamp) {
      timestampEl.textContent = formatTimestamp(this.options.timestamp);
    }
  }

  /**
   * Update options and re-render
   */
  public updateOptions(newOptions: Partial<NoteHeaderOptions>): void {
    this.options = { ...this.options, ...newOptions };

    // If pubkey changed, reload profile
    if (newOptions.pubkey && newOptions.pubkey !== this.options.pubkey) {
      this.profile = null;
      this.loadProfile();
    } else {
      this.updateDisplay();
    }
  }

  /**
   * Get the DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Get current profile
   */
  public getProfile(): UserProfile | null {
    return this.profile;
  }

  /**
   * Set custom CSS classes
   */
  public addClass(className: string): void {
    this.element.classList.add(className);
  }

  public removeClass(className: string): void {
    this.element.classList.remove(className);
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    // Unsubscribe from profile updates
    if (this.unsubscribeProfile) {
      this.unsubscribeProfile();
    }
    // Cleanup NoteMenu
    if (this.noteMenu) {
      this.noteMenu.destroy();
    }
    // Cleanup blinker
    if (this.blinker) {
      this.blinker.destroy();
      this.blinker = null;
    }
    // Cleanup name blinker
    if (this.nameBlinker) {
      this.nameBlinker.destroy();
      this.nameBlinker = null;
    }
    this.element.remove();
  }

  /**
   * Create a note header from HTML attributes (for easy integration)
   */
  public static fromElement(element: HTMLElement): NoteHeader | null {
    const pubkey = element.dataset.pubkey;
    const timestamp = element.dataset.timestamp;

    if (!pubkey || !timestamp) {
      console.warn('NoteHeader requires data-pubkey and data-timestamp attributes');
      return null;
    }

    const options: NoteHeaderOptions = {
      pubkey,
      eventId: element.dataset.eventId || '',
      timestamp: parseInt(timestamp, 10),
      showVerification: element.dataset.showVerification !== 'false',
      showTimestamp: element.dataset.showTimestamp !== 'false'
    };

    const noteHeader = new NoteHeader(options);
    element.appendChild(noteHeader.getElement());

    return noteHeader;
  }

  /**
   * Initialize all note headers in a container
   */
  public static initializeAll(container: HTMLElement = document.body): NoteHeader[] {
    const elements = container.querySelectorAll('[data-note-header]');
    const headers: NoteHeader[] = [];

    elements.forEach(element => {
      const header = NoteHeader.fromElement(element as HTMLElement);
      if (header) {
        headers.push(header);
      }
    });

    return headers;
  }
}
