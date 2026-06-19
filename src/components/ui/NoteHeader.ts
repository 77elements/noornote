/**
 * NoteHeader Component
 * Combines UserIdentity (avatar + name + handle) with note-specific data (timestamp + menu)
 * Uses UserIdentity internally for profile display, eliminating code duplication
 */

import { UserIdentity, UserIdentityConfig } from '../shared/UserIdentity';
import { UserProfileService } from '../../services/UserProfileService';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { NoteMenu } from './NoteMenu';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface NoteHeaderOptions {
  pubkey: string;
  eventId: string;
  timestamp: number;
  rawEvent?: NostrEvent;
  showVerification?: boolean;
  showTimestamp?: boolean;
  showMenu?: boolean;
  showHandle?: boolean;
  relayHints?: string[]; // Relays to try first for the author's profile (e.g. the reposter's write relays)
  onClick?: (pubkey: string) => void;
}

/** Internal options type with defaults applied */
type ResolvedNoteHeaderOptions = Required<Omit<NoteHeaderOptions, 'rawEvent' | 'onClick'>> & Pick<NoteHeaderOptions, 'rawEvent' | 'onClick'>;

export class NoteHeader {
  private element: HTMLElement;
  private userProfileService: UserProfileService;
  private options: ResolvedNoteHeaderOptions;
  private userIdentity: UserIdentity;
  private noteMenu?: NoteMenu;
  private unsubscribeProfile?: () => void;

  constructor(options: NoteHeaderOptions) {
    this.userProfileService = UserProfileService.getInstance();

    this.options = {
      showVerification: true,
      showTimestamp: true,
      showMenu: true,
      showHandle: true,
      relayHints: [],
      ...options
    };

    const identityConfig: UserIdentityConfig = {
      pubkey: this.options.pubkey,
      size: 'medium',
      showAvatar: true,
      showUsername: true,
      showHandle: this.options.showHandle,
      inline: true,
      relayHints: this.options.relayHints,
      enableHoverCard: true,
      clickable: true
    };
    if (this.options.onClick) {
      identityConfig.onClick = this.options.onClick;
    }
    this.userIdentity = new UserIdentity(identityConfig);

    this.element = this.createElement();
    this.setupVerification();
  }

  /**
   * Create the note header element
   */
  private createElement(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'note-header';

    // User identity section (avatar + the inline id-row built by UserIdentity)
    const userSection = document.createElement('div');
    userSection.className = 'note-header__user';
    const identityEl = this.userIdentity.getElement();
    userSection.appendChild(identityEl);

    // Inject the note-specific bits straight into UserIdentity's __info row so
    // name ✓ @handle · time · via all sit on one baseline (mockup order). The
    // verification/timestamp classes are unchanged, so their subscriptions and
    // queries keep working — only their position in the DOM moves.
    const infoEl = identityEl.querySelector('.user-identity__info');
    if (infoEl) {
      const usernameEl = infoEl.querySelector('.user-identity__username');
      const handleEl = infoEl.querySelector('.user-identity__handle');

      // Verification ✓ — directly after the name
      if (this.options.showVerification) {
        const verification = document.createElement('span');
        verification.className = 'note-header__verification';
        verification.style.display = 'none';
        verification.textContent = '✓';
        if (usernameEl) usernameEl.after(verification);
        else infoEl.prepend(verification);
      }

      // NIP-22 comment marker — after the handle
      if (this.options.rawEvent?.kind === 1111) {
        const commentMarker = document.createElement('span');
        commentMarker.className = 'note-header__nip22-marker';
        commentMarker.textContent = 'Kind:1111';
        if (handleEl) handleEl.after(commentMarker);
        else infoEl.appendChild(commentMarker);
      }

      // Timestamp — after the handle (separator dot via CSS ::before)
      if (this.options.showTimestamp) {
        const timestamp = document.createElement('time');
        timestamp.className = 'note-header__timestamp';
        timestamp.innerHTML = formatTimestamp(this.options.timestamp);
        infoEl.appendChild(timestamp);
      }

      // via-client — after the timestamp (separator dot via CSS ::before)
      const clientTag = this.options.rawEvent?.tags?.find((tag: string[]) => tag[0] === 'client');
      if (clientTag?.[1]) {
        const clientEl = document.createElement('span');
        clientEl.className = 'note-header__client';
        clientEl.textContent = `via ${clientTag[1]}`;
        infoEl.appendChild(clientEl);
      }
    }

    header.appendChild(userSection);

    // Note meta section — the menu only (pushed to the right edge)
    const metaSection = document.createElement('div');
    metaSection.className = 'note-header__meta';

    if (this.options.showMenu) {
      const menuContainer = document.createElement('span');
      menuContainer.className = 'note-header__menu-container';

      const menuOptions: { eventId: string; authorPubkey: string; rawEvent?: NostrEvent } = {
        eventId: this.options.eventId,
        authorPubkey: this.options.pubkey
      };
      if (this.options.rawEvent) {
        menuOptions.rawEvent = this.options.rawEvent;
      }
      this.noteMenu = new NoteMenu(menuOptions);
      menuContainer.appendChild(this.noteMenu.getTrigger());

      metaSection.appendChild(menuContainer);
    }

    header.appendChild(metaSection);

    return header;
  }

  /**
   * Setup verification badge (subscribes to profile for NIP-05 verification)
   */
  private setupVerification(): void {
    if (!this.options.showVerification) return;

    this.unsubscribeProfile = this.userProfileService.subscribeToProfile(
      this.options.pubkey,
      (profile) => {
        const verification = this.element.querySelector('.note-header__verification') as HTMLElement;
        if (!verification) return;

        if (this.userProfileService.isVerified(profile)) {
          const nip05s = profile.nip05s && profile.nip05s.length > 0
            ? profile.nip05s
            : (profile.nip05 ? [profile.nip05] : []);
          verification.style.display = 'inline-flex';
          verification.setAttribute('title', `Verified: ${nip05s.join(', ')}`);
        } else {
          verification.style.display = 'none';
        }
      }
    );
  }

  /**
   * Update timestamp (for live updates)
   */
  public updateTimestamp(): void {
    const timestampEl = this.element.querySelector('.note-header__timestamp');
    if (timestampEl && this.options.showTimestamp) {
      timestampEl.innerHTML = formatTimestamp(this.options.timestamp);
    }
  }

  /**
   * Update options and re-render
   */
  public updateOptions(newOptions: Partial<NoteHeaderOptions>): void {
    // For now, just update timestamp if that changed
    if (newOptions.timestamp !== undefined) {
      this.options.timestamp = newOptions.timestamp;
      this.updateTimestamp();
    }
  }

  /**
   * Get the DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Get current profile from UserIdentity
   */
  public getProfile() {
    return this.userIdentity.getProfile();
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
    if (this.unsubscribeProfile) {
      this.unsubscribeProfile();
    }
    if (this.noteMenu) {
      this.noteMenu.destroy();
    }
    this.userIdentity.destroy();
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
