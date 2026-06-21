/**
 * UserHoverCard - Profile preview popup on username hover
 * Shows avatar, username, bio, and follow/unfollow button
 * Similar to Jumble/Twitter user hover cards
 */

import { UserProfileService } from '../../services/UserProfileService';
import { ProfileFollowManager } from '../../lists/follows';
import { AuthService } from '../../services/AuthService';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { hexToNpub, npubToHex } from '../../helpers/nip19';
import type { UserProfile } from '../../services/UserProfileService';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { npubToUsername } from '../../helpers/npubToUsername';
import { ContentProcessor } from '../../services/ContentProcessor';

export class UserHoverCard {
  private static instance: UserHoverCard | null = null;
  private card: HTMLElement | null = null;
  private currentPubkey: string | null = null;
  private hideTimeout: NodeJS.Timeout | null = null;
  private showTimeout: NodeJS.Timeout | null = null;
  private profileService: UserProfileService;
  private authService: AuthService;
  private scrollHandler: (() => void) | null = null;
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  private constructor() {
    this.profileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.setupGlobalListeners();
  }

  static getInstance(): UserHoverCard {
    if (!UserHoverCard.instance) {
      UserHoverCard.instance = new UserHoverCard();
    }
    return UserHoverCard.instance;
  }

  /**
   * Show hover card for a user (with delay)
   */
  public show(pubkey: string, triggerElement: HTMLElement): void {
    // Clear any pending hide
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    // If already showing same user, do nothing
    if (this.currentPubkey === pubkey && this.card) {
      return;
    }

    // Delay showing to avoid flicker on quick mouse movements
    this.showTimeout = setTimeout(() => {
      this.renderCard(pubkey, triggerElement);
    }, 500); // 500ms delay before showing
  }

  /**
   * Hide hover card (with delay)
   */
  public hide(): void {
    // Clear any pending show
    if (this.showTimeout) {
      clearTimeout(this.showTimeout);
      this.showTimeout = null;
    }

    // Delay hiding to allow mouse to move to card
    this.hideTimeout = setTimeout(() => {
      this.removeCard();
    }, 200); // 200ms delay before hiding
  }

  /**
   * Cancel hide (when mouse enters card)
   */
  public cancelHide(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }

  /**
   * Render the hover card
   */
  private async renderCard(pubkey: string, triggerElement: HTMLElement): Promise<void> {
    this.currentPubkey = pubkey;

    // Remove existing card
    this.removeCard();

    // Fetch profile
    const profile = await this.profileService.getUserProfile(pubkey);
    if (!profile) return;

    // Create card
    this.card = document.createElement('div');
    this.card.className = 'user-hover-card';
    this.card.innerHTML = this.getCardHTML(pubkey, profile);

    // Position card
    this.positionCard(triggerElement);

    // Append to body
    document.body.appendChild(this.card);

    // Add event listeners
    this.setupEventListeners(pubkey);
  }

  /**
   * Generate card HTML
   */
  private getCardHTML(pubkey: string, profile: UserProfile): string {
    const isOwnProfile = this.authService.isCurrentUser(pubkey);

    const displayName = profile.display_name || profile.name || 'Anonymous';
    // Use NIP-05(s) if available - prefer nip05s from tags, fallback to single nip05
    const nip05s = profile.nip05s && profile.nip05s.length > 0
      ? profile.nip05s
      : (profile.nip05 ? [profile.nip05] : []);
    const handle = nip05s.length > 0 ? nip05s.join(', ') : (profile.name || 'anon');
    const about = profile.about || '';
    const truncatedAbout = about.length > 160 ? about.slice(0, 160) + '...' : about;
    const avatarUrl = profile.picture || '';

    return `
      <div class="user-hover-card__header">
        <img src="${escapeHtmlAttr(avatarUrl)}" alt="${escapeHtmlAttr(displayName)}" class="user-hover-card__avatar" />
        <div class="user-hover-card__info">
          <div class="user-hover-card__name">${escapeHtml(displayName)}</div>
          <div class="user-hover-card__username">${escapeHtml(handle)}</div>
        </div>
      </div>
      ${truncatedAbout ? `<div class="user-hover-card__bio">${npubToUsername(escapeHtml(truncatedAbout), 'html-multi', (hex: string) => ContentProcessor.getInstance().getNonBlockingProfile(hex))}</div>` : ''}
      ${!isOwnProfile ? `<div class="user-hover-card__actions" data-pubkey="${pubkey}"></div>` : ''}
    `;
  }

  /**
   * Setup event listeners
   */
  private async setupEventListeners(pubkey: string): Promise<void> {
    if (!this.card) return;

    // Prevent card from hiding when hovering over it
    this.card.addEventListener('mouseenter', () => this.cancelHide());
    this.card.addEventListener('mouseleave', () => this.hide());

    // Click on card navigates to profile
    this.card.addEventListener('click', (e) => {
      // Don't navigate if clicking follow button
      if ((e.target as HTMLElement).closest('.user-hover-card__actions')) {
        return;
      }
      const npub = hexToNpub(pubkey);
      if (npub) {
        // Route through the central controller so right-pane mode opens the profile
        // in the secondary pane (scc) instead of navigating the timeline (pcc).
        getViewNavigationController().openView('profile', npub, e as MouseEvent);
        this.removeCard();
      }
    });

    // Render follow button
    const actionsContainer = this.card.querySelector('.user-hover-card__actions');
    if (actionsContainer && this.card) {
      const card = this.card;
      const followManager = new ProfileFollowManager(pubkey);
      await followManager.checkFollowStatus();
      actionsContainer.innerHTML = followManager.renderFollowButton();
      followManager.setupFollowButton(card, () => {
        // Re-render button when follow state changes
        if (actionsContainer && card.isConnected) {
          actionsContainer.innerHTML = followManager.renderFollowButton();
          followManager.setupFollowButton(card, () => {});
        }
      });
    }
  }

  /**
   * Position card near trigger element
   */
  private positionCard(triggerElement: HTMLElement): void {
    if (!this.card) return;

    const rect = triggerElement.getBoundingClientRect();
    const cardWidth = 320;
    const cardHeight = 200; // Approximate

    // Default position: below and centered
    let top = rect.bottom + 10;
    let left = rect.left + (rect.width / 2) - (cardWidth / 2);

    // Adjust if going off screen (right)
    if (left + cardWidth > window.innerWidth) {
      left = window.innerWidth - cardWidth - 10;
    }

    // Adjust if going off screen (left)
    if (left < 10) {
      left = 10;
    }

    // Adjust if going off screen (bottom)
    if (top + cardHeight > window.innerHeight) {
      top = rect.top - cardHeight - 10; // Position above instead
    }

    this.card.style.top = `${top}px`;
    this.card.style.left = `${left}px`;
  }

  /**
   * Setup global listeners for scroll, click outside, and view changes
   */
  private setupGlobalListeners(): void {
    // Scroll handler - hide card immediately when scrolling
    this.scrollHandler = () => {
      this.instantHide();
    };

    // Click outside handler - hide card when clicking anywhere outside
    this.clickOutsideHandler = (e: MouseEvent) => {
      if (!this.card) return;

      const target = e.target as HTMLElement;

      // Don't hide if clicking on the card itself
      if (this.card.contains(target)) {
        return;
      }

      // Don't hide if clicking on a username/avatar that triggers the card
      if (target.closest('.note-header') ||
          target.closest('[data-mention]') ||
          target.closest('.user-identity')) {
        return;
      }

      // Hide the card
      this.instantHide();
    };

    // Add scroll listener to all scrollable containers
    window.addEventListener('scroll', this.scrollHandler, true); // Use capture to catch all scroll events

    // Add click listener to document
    document.addEventListener('click', this.clickOutsideHandler, true); // Use capture for better control
  }

  /**
   * Instantly hide card without delay (for scroll/click events)
   */
  private instantHide(): void {
    // Clear any pending show/hide
    if (this.showTimeout) {
      clearTimeout(this.showTimeout);
      this.showTimeout = null;
    }
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    this.removeCard();
  }

  /**
   * Remove card
   */
  private removeCard(): void {
    if (this.card) {
      this.card.remove();
      this.card = null;
    }
    this.currentPubkey = null;
  }

  /**
   * Destroy singleton: remove global listeners, clear timeouts, remove card
   */
  public destroy(): void {
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler, true);
    }
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler, true);
    }
    if (this.showTimeout) clearTimeout(this.showTimeout);
    if (this.hideTimeout) clearTimeout(this.hideTimeout);
    this.removeCard();
    UserHoverCard.instance = null;
  }


  /**
   * Initialize hover card for all mention links in a container
   * Call this after rendering content with mentions
   */
  public initializeForMentions(container: HTMLElement): void {
    // Find all mention links (created by npubToUsername helper)
    const mentionLinks = container.querySelectorAll('a[href^="/profile/"][data-mention]');

    mentionLinks.forEach((link) => {
      const linkElement = link as HTMLAnchorElement;

      // Extract npub from href
      const href = linkElement.getAttribute('href');
      if (!href) return;

      const npub = href.replace('/profile/', '');

      // Convert npub to hex pubkey
      const hexPubkey = npubToHex(npub);
      if (!hexPubkey) return; // Invalid npub, skip

      // Add hover listeners
      linkElement.addEventListener('mouseenter', (e) => {
        e.stopPropagation(); // Prevent parent note click
        this.show(hexPubkey, linkElement);
      });

      linkElement.addEventListener('mouseleave', () => {
        this.hide();
      });
    });
  }

}
