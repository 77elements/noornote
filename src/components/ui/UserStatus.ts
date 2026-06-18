/**
 * User Status Component
 * Shows current user info with username instead of npub
 */

import { UserProfileService, UserProfile } from '../../services/UserProfileService';
import { extractDisplayName } from '../../helpers/extractDisplayName';

export interface UserStatusOptions {
  npub: string;
  pubkey: string;
  onLogout?: () => void;
}

export class UserStatus {
  private element: HTMLElement;
  private userProfileService: UserProfileService;
  private options: UserStatusOptions;
  private profile: UserProfile | null = null;
  private unsubscribeProfile?: () => void;

  constructor(options: UserStatusOptions) {
    this.userProfileService = UserProfileService.getInstance();
    this.options = options;
    this.element = this.createElement();
    this.loadProfile();
  }

  /**
   * Create user status element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'user-status';
    container.innerHTML = `
      <div class="user-info">
        <span class="user-indicator">●</span>
        <span class="user-display">Loading...</span>
      </div>
      <button class="btn btn--mini" type="button" data-action="logout">Sign Out</button>
    `;

    // Setup logout button
    const logoutBtn = container.querySelector('[data-action="logout"]');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => this.handleLogout());
    }

    return container;
  }

  /**
   * Load user profile and update display
   */
  private async loadProfile(): Promise<void> {
    // Subscribe to profile updates
    this.unsubscribeProfile = this.userProfileService.subscribeToProfile(
      this.options.pubkey,
      (profile: UserProfile) => {
        this.profile = profile;
        this.updateDisplay();
      }
    );

    // Trigger initial load
    try {
      await this.userProfileService.getUserProfile(this.options.pubkey);
    } catch (error) {
      console.warn(`Failed to load profile for user status: ${this.options.pubkey}`, error);
      this.showFallback();
    }
  }

  /**
   * Update display with loaded profile
   */
  private updateDisplay(): void {
    if (!this.profile) {
      this.showFallback();
      return;
    }

    const userDisplay = this.element.querySelector('.user-display');
    if (userDisplay) {
      const displayName = extractDisplayName(this.profile) || 'Anonymous';
      userDisplay.textContent = displayName;
    }
  }

  /**
   * Show fallback when profile loading fails
   */
  private showFallback(): void {
    const userDisplay = this.element.querySelector('.user-display');
    if (userDisplay) {
      // Never show raw npub/hex (User-Display-Rule) — fall back to a neutral label
      userDisplay.textContent = 'Anonymous';
    }
  }

  /**
   * Handle logout button click
   */
  private handleLogout(): void {
    if (this.options.onLogout) {
      this.options.onLogout();
    }
  }

  /**
   * Update user options
   */
  public updateUser(options: UserStatusOptions): void {
    if (this.unsubscribeProfile) {
      this.unsubscribeProfile();
    }

    this.options = options;
    this.profile = null;
    this.loadProfile();
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    if (this.unsubscribeProfile) {
      this.unsubscribeProfile();
    }
    this.element.remove();
  }
}