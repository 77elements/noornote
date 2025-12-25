/**
 * NotificationItem Component
 * Single notification card with icon, author info, action text, and preview
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { NotificationType } from '../../services/orchestration/NotificationsOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { hexToNpub } from '../../helpers/nip19';
import { InteractionStatusLine } from '../ui/InteractionStatusLine';
import { ZapsList } from '../ui/ZapsList';
import { AuthService } from '../../services/AuthService';
import { ReactionsOrchestrator } from '../../services/orchestration/ReactionsOrchestrator';
import { UserIdentity } from '../shared/UserIdentity';
import { resolveQuotedContent } from '../../helpers/resolveQuotedContent';
import { extractOriginalNoteId } from '../../helpers/extractOriginalNoteId';
import { getRepostsOriginalEvent } from '../../helpers/getRepostsOriginalEvent';
import { npubToUsername } from '../../helpers/npubToUsername';
import { formatTimestamp } from '../../helpers/formatTimestamp';

export interface NotificationItemOptions {
  event: NostrEvent;
  type: NotificationType;
  timestamp: number;
}

export class NotificationItem {
  private element: HTMLElement;
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private reactionsOrch: ReactionsOrchestrator;
  private options: NotificationItemOptions;
  private userIdentity: UserIdentity | null = null;
  private isl: InteractionStatusLine | null = null;
  private zapsList: ZapsList | null = null;

  constructor(options: NotificationItemOptions) {
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.reactionsOrch = ReactionsOrchestrator.getInstance();
    this.options = options;
    this.element = this.createElement();
    // UserIdentity is created in createElement() - no need for loadProfile()
    this.attachISL();
    this.loadZapsList();
  }

  /**
   * Create the notification item element
   */
  private createElement(): HTMLElement {
    const item = document.createElement('div');
    item.className = 'ui-list__item ui-list__item--clickable notification-item';
    item.dataset.type = this.options.type; // For CSS styling
    item.addEventListener('click', (e) => this.handleClick(e));

    const icon = this.getIcon(this.options.type);
    const actionText = this.getActionText(this.options.type);
    const preview = this.getPreviewSync();

    // For replies/mentions/thread-replies, add context line for the replied-to note
    const needsContext = this.options.type === 'reply' || this.options.type === 'mention' || this.options.type === 'thread-reply';
    const contextHtml = needsContext ? '<div class="thread-context-item"><span class="thread-context-content">Loading...</span></div>' : '';

    item.innerHTML = `
      <div class="notification-item__icon">${icon}</div>
      <div class="notification-item__content">
        <div class="notification-item__header">
          <div class="notification-item__user-identity"></div>
          <div class="notification-item__info">
            <span class="notification-item__action">${actionText}</span>
          </div>
          ${formatTimestamp(this.options.timestamp)}
        </div>
        ${contextHtml}
        ${preview ? `<div class="notification-item__preview">${this.escapeHtml(preview)}</div>` : ''}
        <div class="notification-item__zaps"></div>
        <div class="notification-item__isl"></div>
      </div>
    `;

    // Insert UserIdentity component
    const identityContainer = item.querySelector('.notification-item__user-identity');
    if (identityContainer) {
      const authorPubkey = this.getAuthorPubkey();
      this.userIdentity = new UserIdentity({
        pubkey: authorPubkey,
        size: 'small',
        showAvatar: true,
        showUsername: true,
        enableHoverCard: true // UserIdentity now handles hover card automatically
      });
      identityContainer.appendChild(this.userIdentity.getElement());
    }

    // Load resolved preview asynchronously
    this.loadResolvedPreview();

    return item;
  }

  /**
   * Load and display zaps list
   */
  private async loadZapsList(): Promise<void> {
    // Only load for mentions, replies, and thread-replies (same as ISL)
    if (this.options.type !== 'mention' && this.options.type !== 'reply' && this.options.type !== 'thread-reply') {
      return;
    }

    const zapsContainer = this.element.querySelector('.notification-item__zaps');
    if (!zapsContainer) return;

    // Fetch stats to get zap events
    const stats = await this.reactionsOrch.getDetailedStats(this.options.event.id);

    if (stats && stats.zapEvents && stats.zapEvents.length > 0) {
      this.zapsList = new ZapsList(stats.zapEvents);
      zapsContainer.appendChild(this.zapsList.getElement());
    }
  }

  /**
   * Attach ISL (Interaction Status Line) to mentions and replies
   */
  private attachISL(): void {
    // Only attach ISL for mentions, replies, and thread-replies (not reactions/zaps/reposts)
    if (this.options.type !== 'mention' && this.options.type !== 'reply' && this.options.type !== 'thread-reply') {
      return;
    }

    const currentUser = this.authService.getCurrentUser();
    const islContainer = this.element.querySelector('.notification-item__isl');
    if (!islContainer || !currentUser) return;

    // Create ISL with the notification event
    this.isl = new InteractionStatusLine({
      noteId: this.options.event.id,
      authorPubkey: this.options.event.pubkey,
      fetchStats: true,
      isLoggedIn: true,
      originalEvent: this.options.event
    });

    islContainer.appendChild(this.isl.getElement());
  }

  /**
   * Get the actual author pubkey (for zaps, extract from tags)
   */
  private getAuthorPubkey(): string {
    // For zaps (kind 9735), the author is in the "P" tag, not event.pubkey
    if (this.options.type === 'zap') {
      const pTag = this.options.event.tags.find((t: string[]) => t[0] === 'P');
      if (pTag && pTag[1]) {
        return pTag[1];
      }
    }

    // For all other types, use event.pubkey
    return this.options.event.pubkey;
  }


  /**
   * Get icon based on notification type (SVG icons matching ISL)
   */
  private getIcon(type: NotificationType): string {
    switch (type) {
      case 'mention':
      case 'reply':
      case 'thread-reply':
        return `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 5.5C2 3.57 3.57 2 5.5 2h5C12.43 2 14 3.57 14 5.5v4c0 1.38-1.12 2.5-2.5 2.5H9l-2 2v-2H5.5C3.57 12 2 10.43 2 8.5v-3z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;

      case 'repost':
        return `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 2l3 3-3 3m3-3H3M6 14l-3-3 3-3m-3 3h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;

      case 'reaction': {
        // Use the actual reaction emoji from event.content (e.g., "👍", "🔥", "💜")
        // Some clients send "+" for like, others send emoji, some send empty string
        const reactionContent = this.options.event.content.trim();

        // If empty or "+", use default heart
        if (!reactionContent || reactionContent === '+') {
          return '♥';
        }

        // Custom emojis (e.g., ":leotoast_sm:", ":nostrich:") - use heart as fallback
        if (reactionContent.startsWith(':') && reactionContent.endsWith(':')) {
          return '♥';
        }

        // Otherwise use the actual emoji
        return reactionContent;
      }

      case 'zap':
        return `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8.5 1L3 9h5l-.5 6 5.5-8h-5l.5-6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>`;

      case 'article':
        return `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 1H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5l-4-4z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M10 1v4h4M8 9H5M11 12H5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;

      case 'hashtag':
        return '🏷️';

      case 'mutual_unfollow':
        return '⚠️';

      case 'mutual_new':
        return '✅';

      default:
        return '🔔';
    }
  }

  /**
   * Get action text based on notification type
   */
  private getActionText(type: NotificationType): string {
    switch (type) {
      case 'mention': return 'mentioned you in a note';
      case 'reply': return 'replied to your note';
      case 'thread-reply': return 'replied to a note that mentioned you';
      case 'repost': return 'reposted your note';
      case 'reaction': return 'reacted to your note';
      case 'zap': {
        const amount = this.getZapAmount();
        return amount ? `zapped ${amount.toLocaleString()} sats` : 'zapped your note';
      }
      case 'article': return 'posted a new article';
      case 'hashtag': {
        const hashtag = this.options.event.meta?.hashtag || 'unknown';
        const count = this.options.event.meta?.count || 1;
        return count === 1
          ? `New post tagged #${hashtag}`
          : `${count} new posts tagged #${hashtag}`;
      }
      case 'mutual_unfollow': return 'stopped following you back';
      case 'mutual_new': return 'started following you back!';
      default: return 'interacted with your note';
    }
  }

  /**
   * Extract zap amount from bolt11 invoice
   */
  private getZapAmount(): number | null {
    if (this.options.type !== 'zap') return null;

    // Get bolt11 invoice from tags
    const bolt11Tag = this.options.event.tags.find((t: string[]) => t[0] === 'bolt11');
    if (!bolt11Tag || !bolt11Tag[1]) return null;

    const invoice = bolt11Tag[1];

    // Extract amount from bolt11 invoice
    // Format: lnbc[amount][multiplier]...
    // Example: lnbc10n... = 1000 sats (n = nano-bitcoin = 0.1 sat)
    const match = invoice.match(/lnbc(\d+)([munp]?)/);
    if (!match) return null;

    const amount = parseInt(match[1]);
    const multiplier = match[2];

    // Convert to sats
    const multipliers: Record<string, number> = {
      '': 100000000, // BTC
      'm': 100000,   // milli-BTC
      'u': 100,      // micro-BTC
      'n': 0.1,      // nano-BTC
      'p': 0.0001    // pico-BTC
    };

    return Math.floor(amount * (multipliers[multiplier] || 1));
  }

  /**
   * Get preview text synchronously (initial render with raw content)
   */
  private getPreviewSync(): string {
    // For mutual notifications, no preview needed
    if (this.options.type === 'mutual_unfollow' || this.options.type === 'mutual_new') {
      return '';
    }

    // For reactions, show placeholder (will fetch the liked note async)
    if (this.options.type === 'reaction') {
      return 'Loading...';
    }

    // For zaps, show placeholder (will fetch the zapped note async)
    if (this.options.type === 'zap') {
      return 'Loading...';
    }

    // For reposts, show placeholder (will be resolved async via getOriginalEvent)
    if (this.options.type === 'repost') {
      // Try quick parse from content (legacy format) for instant display
      try {
        const repostedEvent = JSON.parse(this.options.event.content);
        if (repostedEvent && repostedEvent.content) {
          const maxLength = 100;
          const content = repostedEvent.content;
          return content.length > maxLength ? content.slice(0, maxLength) + '...' : content;
        }
      } catch {
        // Not embedded JSON - will be fetched async
      }
      return 'Loading...';
    }

    const content = this.options.event.content;
    if (!content) return '';

    const maxLength = 100;
    if (content.length > maxLength) {
      return content.slice(0, maxLength) + '...';
    }

    return content;
  }

  /**
   * Load and display resolved preview (with quoted references resolved)
   */
  private async loadResolvedPreview(): Promise<void> {
    // For replies/mentions/thread-replies, fetch the replied-to note for context line ONLY
    // The preview already shows the reply/mention text from getPreviewSync()
    if (this.options.type === 'reply' || this.options.type === 'mention' || this.options.type === 'thread-reply') {
      try {
        // Find the e-tag that references the replied-to note
        const eTag = this.options.event.tags.find((t: string[]) => t[0] === 'e' && t[3] === 'root') ||
                     this.options.event.tags.find((t: string[]) => t[0] === 'e' && t[3] === 'reply') ||
                     this.options.event.tags.find((t: string[]) => t[0] === 'e');

        if (eTag && eTag[1]) {
          const originalEvent = await this.fetchOriginalNote(eTag[1]);
          if (originalEvent && originalEvent.content) {
            const content = originalEvent.content;

            // Load profiles from 'p' tags
            const profiles = new Map();
            const pTags = originalEvent.tags?.filter((t: string[]) => t[0] === 'p') || [];
            for (const tag of pTags) {
              try {
                const profile = await this.userProfileService.getUserProfile(tag[1]);
                profiles.set(tag[1], profile);
              } catch {}
            }

            // Truncate plain text FIRST, THEN resolve mentions with loaded profiles
            const truncatedPlain = content.length > 150 ? content.slice(0, 150) + '...' : content;
            const withMentions = npubToUsername(truncatedPlain, 'html-multi', (hex) => profiles.get(hex) || null);

            // Update context line with replied-to note
            const contextElement = this.element.querySelector('.thread-context-content');
            if (contextElement) {
              contextElement.innerHTML = withMentions;
            }
          }
        }
      } catch (error) {
        console.warn('Failed to fetch replied-to note:', error);
        // Hide loading placeholder on error
        const contextElement = this.element.querySelector('.thread-context-content');
        if (contextElement) {
          contextElement.textContent = '';
        }
      }
      return;
    }

    // For reactions, fetch the liked note content
    if (this.options.type === 'reaction') {
      try {
        const eTag = this.options.event.tags.find((t: string[]) => t[0] === 'e');
        if (!eTag || !eTag[1]) return;

        const originalEvent = await this.fetchOriginalNote(eTag[1]);
        if (originalEvent && originalEvent.content) {
          const maxLength = 100;
          const content = originalEvent.content;
          const truncated = content.length > maxLength ? content.slice(0, maxLength) + '...' : content;

          // Update preview in DOM
          const previewElement = this.element.querySelector('.notification-item__preview');
          if (previewElement) {
            previewElement.textContent = truncated;
          }
        }
      } catch (error) {
        console.warn('Failed to fetch liked note:', error);
        // Hide loading placeholder on error
        const previewElement = this.element.querySelector('.notification-item__preview');
        if (previewElement) {
          previewElement.textContent = '';
        }
      }
      return;
    }

    // For zaps, fetch the zapped note content
    if (this.options.type === 'zap') {
      try {
        const eTag = this.options.event.tags.find((t: string[]) => t[0] === 'e');
        if (!eTag || !eTag[1]) return;

        const originalEvent = await this.fetchOriginalNote(eTag[1]);
        if (originalEvent && originalEvent.content) {
          const maxLength = 100;
          const content = originalEvent.content;
          const truncated = content.length > maxLength ? content.slice(0, maxLength) + '...' : content;

          // Update preview in DOM
          const previewElement = this.element.querySelector('.notification-item__preview');
          if (previewElement) {
            previewElement.textContent = truncated;
          }
        }
      } catch (error) {
        console.warn('Failed to fetch zapped note:', error);
        // Hide loading placeholder on error
        const previewElement = this.element.querySelector('.notification-item__preview');
        if (previewElement) {
          previewElement.textContent = '';
        }
      }
      return;
    }

    // For reposts, fetch the original note content
    if (this.options.type === 'repost') {
      try {
        const originalEvent = await getRepostsOriginalEvent(this.options.event);
        if (originalEvent.content) {
          const maxLength = 100;
          const content = originalEvent.content;
          const truncated = content.length > maxLength ? content.slice(0, maxLength) + '...' : content;

          // Update preview in DOM
          const previewElement = this.element.querySelector('.notification-item__preview');
          if (previewElement) {
            previewElement.textContent = truncated;
          }
          return;
        }
      } catch (error) {
        console.warn('Failed to fetch reposted note:', error);
      }
    }

    const content = this.options.event.content;
    if (!content) return;

    try {
      // Resolve quoted content (replaces nostr:nevent with truncated note content)
      const resolvedContent = await resolveQuotedContent(content);

      // Truncate the resolved content
      const maxLength = 100;
      const truncated = resolvedContent.length > maxLength
        ? resolvedContent.slice(0, maxLength) + '...'
        : resolvedContent;

      // Update preview in DOM
      const previewElement = this.element.querySelector('.notification-item__preview');
      if (previewElement && truncated !== content) {
        previewElement.textContent = truncated;
      }
    } catch (error) {
      console.warn('Failed to resolve quoted content in notification:', error);
      // Keep original preview on error
    }
  }

  /**
   * Handle notification click (navigate to note)
   */
  private handleClick(e: MouseEvent): void {
    // Don't navigate if clicking on ISL buttons
    const target = e.target as HTMLElement;
    if (target.closest('.isl, .isl-action')) {
      return;
    }

    const router = Router.getInstance();

    // For zaps, navigate to zapped event (extract from #e tag)
    if (this.options.type === 'zap') {
      const eTag = this.options.event.tags.find((t: string[]) => t[0] === 'e');
      if (eTag && eTag[1]) {
        router.navigate(`/note/${eTag[1]}`);
        return;
      }
    }

    // For reactions, navigate to reacted event
    if (this.options.type === 'reaction') {
      const eTag = this.options.event.tags.find((t: string[]) => t[0] === 'e');
      if (eTag && eTag[1]) {
        router.navigate(`/note/${eTag[1]}`);
        return;
      }
    }

    // For reposts, navigate to original note (using extractOriginalNoteId helper)
    if (this.options.type === 'repost') {
      const originalNoteId = extractOriginalNoteId(this.options.event);
      router.navigate(`/note/${originalNoteId}`);
      return;
    }

    // For articles, navigate to article view with naddr
    if (this.options.type === 'article') {
      const dTag = this.options.event.tags.find((t: string[]) => t[0] === 'd');
      if (dTag && dTag[1]) {
        router.navigate(`/article/${dTag[1]}`);
        return;
      }
    }

    // For hashtag notifications, trigger hashtag search
    if (this.options.type === 'hashtag') {
      const hashtag = this.options.event.meta?.hashtag;
      if (hashtag) {
        const eventBus = EventBus.getInstance();
        eventBus.emit('hashtagSearch:start', { hashtag });
      }
      return;
    }

    // For mutual notifications, navigate to profile of the person
    if (this.options.type === 'mutual_unfollow' || this.options.type === 'mutual_new') {
      const npub = hexToNpub(this.options.event.pubkey);
      router.navigate(`/profile/${npub}`);
      return;
    }

    // Default: navigate to the notification event itself
    router.navigate(`/note/${this.options.event.id}`);
  }

  /**
   * Fetch original note by ID
   * Uses configured read relays from NostrTransport
   */
  private async fetchOriginalNote(noteId: string): Promise<NostrEvent | null> {
    const { NostrTransport } = await import('../../services/transport/NostrTransport');
    const transport = NostrTransport.getInstance();

    try {
      // Get read relays from config
      const readRelays = transport.getReadRelays();

      const events = await transport.fetch(
        readRelays,
        [{
          ids: [noteId],
          kinds: [1, 30023], // Kind 1 = short notes, Kind 30023 = long-form articles
          limit: 1
        }]
      );

      return events[0] || null;
    } catch (error) {
      console.error('[NotificationItem] Failed to fetch original note:', error);
      return null;
    }
  }


  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get the element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.userIdentity) {
      this.userIdentity.destroy();
    }
    if (this.isl) {
      this.isl.destroy();
    }
    if (this.zapsList) {
      this.zapsList.destroy();
    }
    this.element.remove();
  }
}
