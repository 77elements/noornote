/**
 * BookmarkCard
 * Renders a single bookmark as a draggable card
 *
 * @purpose Display bookmark with author, content preview, and delete action
 * @used-by BookmarkSecondaryManager
 */

import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface BookmarkCardData {
  id: string;              // Bookmark ID (always available from localStorage)
  type?: string;           // 'e' (event), 'r' (URL), 't' (hashtag), 'a' (replaceable event)
  value?: string;          // The bookmark value (same as ID for e, URL for r, etc.)
  event?: NostrEvent;      // Event data (may be undefined if not loaded)
  isPrivate: boolean;
  folderId?: string;
  description?: string;    // Optional user description for URL bookmarks
}

export interface BookmarkCardOptions {
  onDelete: (eventId: string) => Promise<void>;
  onEdit?: (bookmarkId: string) => void;
}

export class BookmarkCard {
  private data: BookmarkCardData;
  private options: BookmarkCardOptions;
  private element: HTMLElement | null = null;
  private userProfileService: UserProfileService;
  private router: Router;

  constructor(data: BookmarkCardData, options: BookmarkCardOptions) {
    this.data = data;
    this.options = options;
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();
  }

  public async render(): Promise<HTMLElement> {
    const { id, event, isPrivate } = this.data;

    // Create card element
    const card = document.createElement('div');
    card.className = 'bookmark-card';
    card.dataset.eventId = id;
    card.dataset.bookmarkId = id;

    if (event) {
      // Normal card with event data
      const profile = await this.userProfileService.getUserProfile(event.pubkey);
      const username = profile?.name || 'Anonymous';
      const profilePic = profile?.picture || '';
      const snippet = this.getTextSnippet(event.content, 100);
      const timeAgo = formatTimestamp(event.created_at);

      card.innerHTML = `
        ${isPrivate ? '<span class="bookmark-card__private-badge">🔒</span>' : ''}
        <div class="bookmark-card__author">
          ${profilePic
            ? `<img class="bookmark-card__author-pic" src="${this.escapeHtml(profilePic)}" alt="" loading="lazy" />`
            : '<div class="bookmark-card__author-pic"></div>'
          }
          <span class="bookmark-card__author-name">${this.escapeHtml(username)}</span>
        </div>
        <div class="bookmark-card__content">${this.escapeHtml(snippet)}</div>
        <div class="bookmark-card__footer">
          <span class="bookmark-card__timestamp">${timeAgo}</span>
          <button class="bookmark-card__delete" aria-label="Remove bookmark" title="Remove bookmark">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v4M10 7v4M4 4l.5 8.5a1 1 0 0 0 1 .95h5a1 1 0 0 0 1-.95L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      `;
    } else {
      // Fallback card when event is not loaded
      // Display depends on bookmark type
      const { type, value, description } = this.data;
      let displayContent = '';
      let displayLabel = 'Unknown';
      let isContentHtml = false;
      let footerText = '—';

      if (type === 'r' && value) {
        // URL bookmark - show the URL as a real link (global handler in App.ts opens in external browser)
        displayLabel = 'URL';
        let displayUrl = '';
        try {
          const url = new URL(value);
          displayUrl = url.hostname + (url.pathname !== '/' ? url.pathname.slice(0, 30) : '');
        } catch {
          displayUrl = value.slice(0, 40);
        }
        // Render as anchor so App.ts global click handler opens in external browser
        displayContent = `<a href="${this.escapeHtml(value)}" class="bookmark-card__external-link">${this.escapeHtml(displayUrl)}</a>`;
        // Add description below URL if available
        if (description) {
          const descText = description.length > 60 ? description.slice(0, 60) + '...' : description;
          displayContent += `<span class="bookmark-card__description">${this.escapeHtml(descText)}</span>`;
        }
        isContentHtml = true;
      } else if (type === 't' && value) {
        // Hashtag bookmark
        displayLabel = 'Hashtag';
        displayContent = `#${value}`;
      } else if (type === 'a' && value) {
        // Replaceable event address
        displayLabel = 'Address';
        displayContent = value.slice(0, 40) + '...';
      } else {
        // Event reference that couldn't be loaded
        displayLabel = 'Note not found';
        displayContent = id.slice(0, 8) + '...';
      }

      card.innerHTML = `
        ${isPrivate ? '<span class="bookmark-card__private-badge">🔒</span>' : ''}
        <div class="bookmark-card__author">
          <div class="bookmark-card__author-pic bookmark-card__author-pic--type-${type || 'e'}"></div>
          <span class="bookmark-card__author-name">${this.escapeHtml(displayLabel)}</span>
        </div>
        <div class="bookmark-card__content bookmark-card__content--${type === 'e' || !type ? 'not-found' : 'external'}">
          ${isContentHtml ? displayContent : this.escapeHtml(displayContent)}
        </div>
        <div class="bookmark-card__footer">
          <span class="bookmark-card__timestamp">${this.escapeHtml(footerText)}</span>
          <div class="bookmark-card__actions">
            ${type === 'r' ? `
              <button class="btn btn--mini bookmark-card__edit" aria-label="Edit bookmark" title="Edit bookmark">
                Edit
              </button>
            ` : ''}
            <button class="bookmark-card__delete" aria-label="Remove bookmark" title="Remove bookmark">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v4M10 7v4M4 4l.5 8.5a1 1 0 0 0 1 .95h5a1 1 0 0 0 1-.95L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      `;

    }

    // Bind events
    this.bindEvents(card);

    this.element = card;
    return card;
  }

  private bindEvents(card: HTMLElement): void {
    const { id, event } = this.data;

    // Click on card navigates to note or opens external URL
    card.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.bookmark-card__delete') || target.closest('.bookmark-card__edit')) return;

      // Don't navigate if we were dragging
      if (card.dataset.wasDragging === 'true') {
        card.dataset.wasDragging = 'false';
        return;
      }

      // Check if click was on an external link
      const anchor = target.closest('a');
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          e.preventDefault();
          e.stopPropagation();
          // Open in external browser
          const { open } = await import('@tauri-apps/plugin-shell');
          await open(href);
          return;
        }
      }

      // Navigate to note if event exists
      if (event?.id) {
        const nevent = encodeNevent(event.id);
        this.router.navigate(`/note/${nevent}`);
      }
    });

    // Edit button (only for URL bookmarks)
    const editBtn = card.querySelector('.bookmark-card__edit');
    editBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.options.onEdit?.(id);
    });

    // Delete button
    const deleteBtn = card.querySelector('.bookmark-card__delete');
    deleteBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.options.onDelete(id);
      card.remove();
    });
  }

  private getTextSnippet(content: string, maxLength: number): string {
    let text = content
      .replace(/nostr:(note|nevent|npub|nprofile|naddr|nrelay)[a-zA-Z0-9]+/g, '')
      .replace(/^>.*$/gm, '')
      .replace(/https?:\/\/[^\s]+/g, '')
      .trim();

    if (text.length > maxLength) {
      return text.substring(0, maxLength) + '...';
    }
    return text || '(No text content)';
  }


  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  public getElement(): HTMLElement | null {
    return this.element;
  }

  public getEventId(): string {
    return this.data.id;
  }
}
