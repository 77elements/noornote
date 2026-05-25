/**
 * LikesList Component
 * Displays horizontal list of reaction badges (emoji + count) between ZapsList and ISL in SNV
 * Groups reactions by emoji, sorted by count (most popular first)
 * Allows clicking badges to react with the same emoji
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { AuthGuard } from '../../services/AuthGuard';
import { resolveReactionEmoji } from '../../helpers/formatCustomEmojis';

interface ReactionGroup {
  emoji: string;
  emojiHtml: string;
  count: number;
}

export class LikesList {
  private element: HTMLElement | null = null;
  private reactionEvents: NostrEvent[];
  private noteId: string;
  private authorPubkey: string;
  private reactionsApi: ReactionsModuleApi | null;
  /** Original reacted-to event — required for NIP-25-compliant reactions on
   *  addressable events (long-form articles etc.) so the e-tag carries the
   *  hex event-id and `a` + `k` tags are added. */
  private originalEvent?: NostrEvent;

  constructor(reactionEvents: NostrEvent[], noteId: string, authorPubkey: string, originalEvent?: NostrEvent) {
    this.reactionEvents = reactionEvents;
    this.noteId = noteId;
    this.authorPubkey = authorPubkey;
    this.reactionsApi = ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
    if (originalEvent) this.originalEvent = originalEvent;
  }

  /**
   * Initialize the component (must be called after constructor)
   */
  public async init(): Promise<void> {
    this.element = await this.createElement();
  }

  /**
   * Group reactions by emoji and count occurrences
   */
  private groupReactions(): ReactionGroup[] {
    const groups = new Map<string, number>();
    const emojiHtmlMap = new Map<string, string>();

    for (const event of this.reactionEvents) {
      // NIP-25: content can be "+", "-", emoji, or empty
      const content = event.content.trim();
      let emoji = content;

      // Normalize "+" and empty to heart emoji
      if (content === '+' || content === '') {
        emoji = '❤️';
      } else if (content === '-') {
        // Skip downvotes (we don't display them)
        continue;
      }

      // Resolve custom emoji :shortcode: to <img> tag (NIP-30)
      if (emoji.startsWith(':') && emoji.endsWith(':') && !emojiHtmlMap.has(emoji)) {
        emojiHtmlMap.set(emoji, resolveReactionEmoji(event));
      }

      // Count emoji
      const current = groups.get(emoji) || 0;
      groups.set(emoji, current + 1);
    }

    // Convert to array and sort by count (most popular first)
    const result: ReactionGroup[] = [];
    groups.forEach((count, emoji) => {
      result.push({ emoji, emojiHtml: emojiHtmlMap.get(emoji) || emoji, count });
    });

    result.sort((a, b) => b.count - a.count);

    return result;
  }

  /**
   * Create LikesList element
   */
  private async createElement(): Promise<HTMLElement> {
    const container = document.createElement('div');
    container.className = 'likes-list';

    const groups = this.groupReactions();

    if (groups.length === 0) {
      container.style.display = 'none';
      return container;
    }

    // Create scrollable inner container
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'likes-list__scroll';

    // Create reaction badges (emoji + count)
    for (const group of groups) {
      const badge = document.createElement('button');
      badge.className = 'likes-list__badge';
      badge.type = 'button';

      // Check if user has already reacted with this emoji
      const hasReacted = await this.reactionsApi?.hasUserLikedWithEmoji(this.noteId, group.emoji);
      if (hasReacted) {
        badge.classList.add('likes-list__badge--active');
        badge.disabled = true; // Disable if user already reacted
      }

      badge.innerHTML = `
        <span class="likes-list__emoji">${group.emojiHtml}</span>
        <span class="likes-list__count">${group.count}</span>
      `;

      // Add click handler
      badge.addEventListener('click', () => this.handleBadgeClick(group.emoji, badge));

      scrollContainer.appendChild(badge);
    }

    container.appendChild(scrollContainer);

    return container;
  }

  /**
   * Handle badge click - React with the same emoji
   */
  private async handleBadgeClick(emoji: string, badge: HTMLButtonElement): Promise<void> {
    // Prevent multiple clicks
    if (badge.disabled) {
      return;
    }

    // Check authentication
    if (!AuthGuard.requireAuth('react to note')) {
      return;
    }

    // Check if already reacted with this emoji (before disabling)
    const hasReacted = await this.reactionsApi?.hasUserLikedWithEmoji(this.noteId, emoji);
    if (hasReacted) {
      return; // Already reacted, do nothing
    }

    // Disable button immediately to prevent multiple clicks
    badge.disabled = true;

    // Publish reaction — ReactionService resolves own write-relays
    // and the author's NIP-65 outbox internally (Amethyst pattern).
    const result = await this.reactionsApi?.publishReaction({
      noteId: this.noteId,
      authorPubkey: this.authorPubkey,
      emoji,
      ...(this.originalEvent ? { targetEvent: this.originalEvent } : {}),
    });

    if (result?.success) {
      // Mark badge as active
      badge.classList.add('likes-list__badge--active');

      // Update count
      const countElement = badge.querySelector('.likes-list__count');
      if (countElement) {
        const currentCount = parseInt(countElement.textContent || '0', 10);
        countElement.textContent = String(currentCount + 1);
      }
    } else {
      // Re-enable button if publishing failed
      badge.disabled = false;
    }
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    if (!this.element) {
      throw new Error('LikesList not initialized. Call init() first.');
    }
    return this.element;
  }

  /**
   * Destroy component
   */
  public destroy(): void {
    if (this.element) {
      this.element.remove();
    }
  }
}
