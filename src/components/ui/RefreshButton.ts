/**
 * RefreshButton Component
 * Smart refresh button that shows when new notes are available
 * Displays stacked profile pictures of note authors
 */

import { UserProfileService } from '../../services/UserProfileService';
import { escapeCssUrl } from '../../helpers/escapeHtml';

export interface RefreshButtonOptions {
  newNotesCount: number;
  authorPubkeys: string[]; // Max 4, newest first
  onClick: () => void;
}

export class RefreshButton {
  private element: HTMLElement;
  private newNotesCount: number = 0;
  private authorPubkeys: string[] = [];
  private onClick: () => void;
  private avatarsContainer: HTMLElement | null = null;
  private textSpan: HTMLElement | null = null;

  constructor(options: RefreshButtonOptions) {
    this.newNotesCount = options.newNotesCount;
    this.authorPubkeys = options.authorPubkeys;
    this.onClick = options.onClick;
    this.element = this.createElement();
    void this.updateContent();
  }

  /**
   * Create the button element
   */
  private createElement(): HTMLElement {
    const button = document.createElement('button');
    button.className = 'btn btn--refresh btn--refresh-new-notes';
    button.type = 'button';
    button.style.display = 'none'; // Hidden by default

    button.innerHTML = `
      <div class="btn--refresh-new-notes__avatars"></div>
      <span class="btn--refresh-new-notes__text"></span>
    `;

    button.addEventListener('click', () => {
      this.onClick();
      this.hide(); // Hide after click
    });

    this.avatarsContainer = button.querySelector(
      '.btn--refresh-new-notes__avatars'
    );
    this.textSpan = button.querySelector('.btn--refresh-new-notes__text');

    return button;
  }

  /**
   * Update button content with new notes info
   */
  public async update(
    newNotesCount: number,
    authorPubkeys: string[]
  ): Promise<void> {
    this.newNotesCount = newNotesCount;
    this.authorPubkeys = authorPubkeys.slice(0, 4); // Max 4 avatars
    await this.updateContent();
    this.show();
  }

  /**
   * Update avatars and text
   */
  private async updateContent(): Promise<void> {
    // Update text
    if (this.textSpan) {
      this.textSpan.textContent = `${this.newNotesCount} new`;
    }

    // Update avatars
    if (this.avatarsContainer) {
      this.avatarsContainer.innerHTML = ''; // Clear existing

      // Fetch and render avatars (max 4)
      const avatarPromises = this.authorPubkeys.map(pubkey =>
        this.createAvatarElement(pubkey)
      );
      const avatars = await Promise.all(avatarPromises);

      avatars.forEach(avatar => {
        this.avatarsContainer!.appendChild(avatar);
      });
    }
  }

  /**
   * Create a single avatar element
   */
  private async createAvatarElement(pubkey: string): Promise<HTMLElement> {
    const avatar = document.createElement('div');
    avatar.className = 'btn--refresh-new-notes__avatar';

    try {
      const profileService = UserProfileService.getInstance();
      const profile = await profileService.getUserProfile(pubkey);

      if (profile?.picture) {
        avatar.style.backgroundImage = `url('${escapeCssUrl(profile.picture)}')`;
      }
      // No fallback - just don't show avatar if profile not loaded
    } catch (error) {
      console.warn('Failed to load avatar for', pubkey, error);
    }

    return avatar;
  }

  /**
   * Show the button
   */
  public show(): void {
    this.element.style.display = 'flex';
  }

  /**
   * Hide the button
   */
  public hide(): void {
    this.element.style.display = 'none';
  }

  /**
   * Get the DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Destroy the button
   */
  public destroy(): void {
    this.element.remove();
  }
}
