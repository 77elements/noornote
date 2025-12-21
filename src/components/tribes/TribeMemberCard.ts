/**
 * TribeMemberCard
 * Renders a single tribe member as a draggable card
 *
 * @purpose Display member with avatar, username, and delete action
 * @used-by TribeSecondaryManager
 */

import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { encodeNpub } from '../../services/NostrToolsAdapter';

export interface TribeMemberCardData {
  pubkey: string;
  isPrivate: boolean;
  folderId?: string;
}

export interface TribeMemberCardOptions {
  onDelete: (pubkey: string) => Promise<void>;
}

export class TribeMemberCard {
  private data: TribeMemberCardData;
  private options: TribeMemberCardOptions;
  private element: HTMLElement | null = null;
  private userProfileService: UserProfileService;
  private router: Router;

  constructor(data: TribeMemberCardData, options: TribeMemberCardOptions) {
    this.data = data;
    this.options = options;
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();
  }

  public async render(): Promise<HTMLElement> {
    const { pubkey, isPrivate } = this.data;

    // Create card element
    const card = document.createElement('div');
    card.className = 'tribe-member-card';
    card.dataset.pubkey = pubkey;

    // Fetch user profile
    const profile = await this.userProfileService.getUserProfile(pubkey);
    const username = profile?.name || profile?.display_name || 'Anonymous';
    const profilePic = profile?.picture || '';

    card.innerHTML = `
      ${isPrivate ? '<span class="tribe-member-card__private-badge">🔒</span>' : ''}
      <div class="tribe-member-card__content">
        <div class="tribe-member-card__avatar">
          ${profilePic
            ? `<img class="tribe-member-card__avatar-img" src="${this.escapeHtml(profilePic)}" alt="" loading="lazy" />`
            : '<div class="tribe-member-card__avatar-img tribe-member-card__avatar-img--empty"></div>'
          }
        </div>
        <div class="tribe-member-card__info">
          <span class="tribe-member-card__username">${this.escapeHtml(username)}</span>
          <span class="tribe-member-card__pubkey">${this.escapeHtml(pubkey.slice(0, 8))}...</span>
        </div>
      </div>
      <button class="tribe-member-card__delete" aria-label="Remove member" title="Remove member">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v4M10 7v4M4 4l.5 8.5a1 1 0 0 0 1 .95h5a1 1 0 0 0 1-.95L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    `;

    // Bind events
    this.bindEvents(card);

    this.element = card;
    return card;
  }

  private bindEvents(card: HTMLElement): void {
    const { pubkey } = this.data;

    // Click on card navigates to profile
    card.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.tribe-member-card__delete')) return;

      // Don't navigate if we were dragging
      if (card.dataset.wasDragging === 'true') {
        card.dataset.wasDragging = 'false';
        return;
      }

      // Navigate to profile
      const npub = encodeNpub(pubkey);
      this.router.navigate(`/profile/${npub}`);
    });

    // Delete button
    const deleteBtn = card.querySelector('.tribe-member-card__delete');
    deleteBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.options.onDelete(pubkey);
      card.remove();
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  public getElement(): HTMLElement | null {
    return this.element;
  }

  public getPubkey(): string {
    return this.data.pubkey;
  }
}
