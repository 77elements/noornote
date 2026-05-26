/**
 * ReplyIndicator Component
 * Shows "Reply to [avatar] [username]" above note content
 * Clickable to navigate to parent note
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { SingleNoteModuleApi } from '../../modules/single-note/contracts';
import { Router } from '../../services/Router';
import { encodeNevent } from '../../services/NostrToolsAdapter';

export interface ReplyIndicatorOptions {
  parentEventId: string;
  relayHint: string | null;
}

export class ReplyIndicator {
  private element: HTMLElement;
  private options: ReplyIndicatorOptions;
  private _singleNoteApi?: SingleNoteModuleApi | null;
  private get singleNoteApi(): SingleNoteModuleApi | null {
    return this._singleNoteApi ??= ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note');
  }

  constructor(options: ReplyIndicatorOptions) {
    this.options = options;
    this.element = this.createElement();

    // Load parent author info asynchronously
    this.loadParentAuthor();
  }

  /**
   * Create HTML structure
   */
  private createElement(): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'reply-indicator';
    indicator.dataset.parentEventId = this.options.parentEventId;
    if (this.options.relayHint) {
      indicator.dataset.relayHint = this.options.relayHint;
    }

    indicator.innerHTML = `
      Reply to
      <img class="reply-avatar" src="" alt="" />
      <span class="reply-username">Loading...</span>
    `;

    return indicator;
  }

  /**
   * Load parent author info and update UI
   */
  private async loadParentAuthor(): Promise<void> {
    try {
      const info = await (this.singleNoteApi?.fetchParentAuthor(
        this.options.parentEventId,
        this.options.relayHint
      ) ?? Promise.resolve(null));

      if (!info) {
        // Parent not found
        const avatarEl = this.element.querySelector('.reply-avatar') as HTMLImageElement;
        const usernameEl = this.element.querySelector('.reply-username');
        if (avatarEl) avatarEl.remove();
        if (usernameEl) usernameEl.textContent = '[Note not found]';
        return;
      }

      // Update avatar and username
      const avatarEl = this.element.querySelector('.reply-avatar') as HTMLImageElement;
      const usernameEl = this.element.querySelector('.reply-username');

      if (avatarEl) {
        avatarEl.src = info.avatarUrl;
        avatarEl.alt = info.displayName;
      }

      if (usernameEl) {
        usernameEl.textContent = info.displayName;
      }

      // Make clickable - navigate to parent note
      this.element.style.cursor = 'pointer';
      this.element.addEventListener('click', (e) => {
        e.stopPropagation();
        const router = Router.getInstance();
        const nevent = encodeNevent(this.options.parentEventId);
        router.navigate(`/note/${nevent}`);
      });

    } catch (error) {
      console.error('Failed to load parent author:', error);
      const avatarEl = this.element.querySelector('.reply-avatar') as HTMLImageElement;
      const usernameEl = this.element.querySelector('.reply-username');
      if (avatarEl) avatarEl.remove();
      if (usernameEl) usernameEl.textContent = '[Error loading]';
    }
  }

  /**
   * Get the HTML element
   */
  getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.element.remove();
  }
}
