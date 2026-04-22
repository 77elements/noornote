/**
 * NotificationItem Component
 * Single notification card with icon, author info, action text, and preview
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { NotificationType } from '../../services/orchestration/NotificationsOrchestrator';
import { USER_CONTENT_KINDS } from '../../types/nostr';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { EventBus } from '../../services/EventBus';
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
import { resolveReactionEmoji } from '../../helpers/formatCustomEmojis';
import { escapeHtml } from '../../helpers/escapeHtml';

export interface NotificationItemOptions {
  event: NostrEvent;
  type: NotificationType;
  timestamp: number;
  meta?: { hashtag?: string; count?: number };
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
    this.loadResolvedPreview();
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

    // For hashtag notifications, add footer with search and unsubscribe links
    const hashtag = this.options.meta?.hashtag;
    const hashtagFooterHtml = this.options.type === 'hashtag' && hashtag
      ? `<div class="notification-item__footer">
          <a href="#" class="notification-item__footer-link notification-item__footer-link--search" data-hashtag="${hashtag}">Open notes tagged #${hashtag}</a>
          <a href="#" class="notification-item__footer-link notification-item__footer-link--unsubscribe" data-hashtag="${hashtag}">Unsubscribe from #${hashtag}</a>
        </div>`
      : '';

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
        ${preview ? `<div class="notification-item__preview">${escapeHtml(preview)}</div>` : ''}
        <div class="notification-item__zaps"></div>
        ${hashtagFooterHtml}
      </div>
    `;

    // Insert UserIdentity component (anonymized for poll votes)
    const identityContainer = item.querySelector('.notification-item__user-identity');
    if (identityContainer) {
      if (this.options.type === 'poll_vote') {
        // NIP-88 votes: don't expose the voter — show neutral "Someone" instead.
        identityContainer.innerHTML = '<span class="notification-item__anonymous">Someone</span>';
      } else {
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
    }

    // Setup hashtag footer link handlers
    this.setupHashtagFooterLinks(item);

    return item;
  }

  /**
   * Setup click handlers for hashtag footer links
   */
  private setupHashtagFooterLinks(item: HTMLElement): void {
    // Search link - opens hashtag search in scc
    const searchLink = item.querySelector('.notification-item__footer-link--search');
    if (searchLink) {
      searchLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hashtag = (searchLink as HTMLElement).dataset.hashtag;
        if (hashtag) {
          const eventBus = EventBus.getInstance();
          eventBus.emit('hashtagSearch:start', { hashtag });
        }
      });
    }

    // Subscribe/Unsubscribe toggle link
    const toggleLink = item.querySelector('.notification-item__footer-link--unsubscribe') as HTMLElement;
    if (toggleLink) {
      toggleLink.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hashtag = toggleLink.dataset.hashtag;
        if (hashtag) {
          const { HashtagNotificationService } = await import('../../addons/hashtag-subscriptions/HashtagNotificationService');
          const hashtagService = HashtagNotificationService.getInstance();
          const { ToastService } = await import('../../services/ToastService');

          const isSubscribed = hashtagService.isSubscribed(hashtag);
          if (isSubscribed) {
            hashtagService.unsubscribe(hashtag);
            toggleLink.textContent = `Subscribe to #${hashtag}`;
            toggleLink.classList.remove('notification-item__footer-link--unsubscribe');
            toggleLink.classList.add('notification-item__footer-link--subscribe');
            ToastService.show(`Unsubscribed from #${hashtag}`, 'success');
          } else {
            hashtagService.subscribe(hashtag);
            toggleLink.textContent = `Unsubscribe from #${hashtag}`;
            toggleLink.classList.remove('notification-item__footer-link--subscribe');
            toggleLink.classList.add('notification-item__footer-link--unsubscribe');
            ToastService.show(`Subscribed to #${hashtag}`, 'success');
          }
        }
      });
    }
  }

  /**
   * Check if notification type is a text-based notification (mention, reply, thread-reply)
   * These types show ISL, zaps list, and context line
   */
  private isTextNotification(): boolean {
    const type = this.options.type;
    return type === 'mention' || type === 'reply' || type === 'thread-reply';
  }

  /**
   * Load and display zaps list
   */
  private async loadZapsList(): Promise<void> {
    if (!this.isTextNotification()) return;

    const zapsContainer = this.element.querySelector('.notification-item__zaps');
    if (!zapsContainer) return;

    const eventId = this.options.event.id;
    if (!eventId) return;

    // Fetch stats to get zap events
    const stats = await this.reactionsOrch.getDetailedStats(eventId);

    if (stats && stats.zapEvents && stats.zapEvents.length > 0) {
      this.zapsList = new ZapsList(stats.zapEvents);
      zapsContainer.appendChild(this.zapsList.getElement());
    }
  }

  /**
   * Attach ISL (Interaction Status Line) to mentions and replies
   */
  private attachISL(): void {
    if (!this.isTextNotification()) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    const content = this.element.querySelector('.notification-item__content');
    if (!content) return;

    const noteId = this.options.event.id;
    if (!noteId) return;

    // Create ISL with the notification event
    this.isl = new InteractionStatusLine({
      noteId,
      authorPubkey: this.options.event.pubkey,
      fetchStats: true,
      isLoggedIn: true,
      originalEvent: this.options.event
    });

    const footer = content.querySelector('.notification-item__footer');
    if (footer) {
      content.insertBefore(this.isl.getElement(), footer);
    } else {
      content.appendChild(this.isl.getElement());
    }
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
        return `<svg width="18" height="18"><use href="#icon-reply"/></svg>`;

      case 'repost':
        return `<svg width="18" height="18"><use href="#icon-repost"/></svg>`;

      case 'reaction': {
        // Use the actual reaction emoji from event.content (e.g., "👍", "🔥", "💜")
        // Some clients send "+" for like, others send emoji, some send empty string
        const reactionContent = this.options.event.content.trim();

        // If empty or "+", use default heart
        if (!reactionContent || reactionContent === '+') {
          return '♥';
        }

        // Custom emojis (NIP-30) - resolve :shortcode: to <img> tag
        if (reactionContent.startsWith(':') && reactionContent.endsWith(':')) {
          return resolveReactionEmoji(this.options.event);
        }

        // Otherwise use the actual emoji (escape to prevent XSS via crafted reaction content)
        return escapeHtml(reactionContent);
      }

      case 'zap':
        return `<svg width="18" height="18"><use href="#icon-zap"/></svg>`;

      case 'poll_vote':
        return '🗳️';

      case 'article':
        return `<svg width="18" height="18"><use href="#icon-article-16"/></svg>`;

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
   * Get kind-aware label for the target content ("note", "article", "follow pack", …).
   * Falls back to "event" when target kind is known but not specially handled,
   * so we never lie about the target type.
   */
  private getTargetLabel(): string {
    // Mentions: target IS the mentioning event itself — use its own kind.
    // (Interactions like reactions/zaps target a referenced event via a-/k-tag, handled below.)
    if (this.options.type === 'mention') {
      const k = this.options.event.kind;
      if (k === 20) return 'picture';
      if (k === 21 || k === 22) return 'video';
      if (k === 1063) return 'file';
      if (k === 1068) return 'poll';
      if (k === 1111) return 'comment';
    }
    const aTag = this.options.event.tags.find((t: string[]) => t[0] === 'a');
    if (aTag?.[1]) {
      const kind = parseInt(aTag[1].split(':')[0] || '');
      if (kind === 30023) return 'article';
      if (kind === 32267) return 'app on Zapstore';
      if (kind === 39089) return 'follow pack';
      if (!isNaN(kind)) return 'event';
    }
    const kTag = this.options.event.tags.find((t: string[]) => t[0] === 'k');
    if (kTag?.[1]) {
      const kind = parseInt(kTag[1]);
      if (kind === 1063) return 'file';
      if (kind === 20) return 'picture';
      if (kind === 21 || kind === 22) return 'video';
      if (kind === 1068) return 'poll';
      if (kind === 30023) return 'article';
      if (kind === 32267) return 'app on Zapstore';
      if (kind === 39089) return 'follow pack';
      if (!isNaN(kind)) return 'event';
    }
    return 'note';
  }

  /**
   * Get action text based on notification type
   */
  private getActionText(type: NotificationType): string {
    const target = this.getTargetLabel();
    switch (type) {
      case 'mention': return `mentioned you in a ${target}`;
      case 'reply': return `replied to your ${target}`;
      case 'thread-reply': return `replied to a ${target} that mentioned you`;
      case 'repost': return `reposted your ${target}`;
      case 'reaction': return `reacted to your ${target}`;
      case 'zap': {
        const amount = this.getZapAmount();
        return amount ? `zapped your ${target} ${amount.toLocaleString()} sats` : `zapped your ${target}`;
      }
      case 'poll_vote': return 'voted on your poll';
      case 'article': return 'posted a new article';
      case 'hashtag': {
        const hashtag = this.options.meta?.hashtag || 'unknown';
        const count = this.options.meta?.count || 1;
        return count === 1
          ? `New post tagged #${hashtag}`
          : `${count} new posts tagged #${hashtag}`;
      }
      case 'mutual_unfollow': return 'stopped following you back';
      case 'mutual_new': return 'started following you back!';
      default: return `interacted with your ${target}`;
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
    if (!match || !match[1]) return null;

    const amount = parseInt(match[1]);
    const multiplier = match[2] || '';

    // Convert to sats
    const multipliers: Record<string, number> = {
      '': 100000000, // BTC
      'm': 100000,   // milli-BTC
      'u': 100,      // micro-BTC
      'n': 0.1,      // nano-BTC
      'p': 0.0001    // pico-BTC
    };

    return Math.floor(amount * (multipliers[multiplier] ?? 1));
  }

  /**
   * Short hex identifier for target preview when full content can't be resolved.
   */
  private shortEventId(hex: string | null | undefined): string {
    return hex ? hex.slice(0, 8) : '';
  }

  /**
   * Fallback preview text when we couldn't fetch the referenced event content.
   * Priority: addressable (a-tag) kind label → e-tag short id → empty.
   */
  private buildUnresolvedPreview(): string {
    const aTag = this.options.event.tags.find((t: string[]) => t[0] === 'a');
    if (aTag?.[1]) {
      const parts = aTag[1].split(':');
      const aKind = parseInt(parts[0] || '');
      const dTag = parts[2] || '';
      if (aKind === 30023) return 'Article';
      if (aKind === 32267) return 'App';
      if (aKind === 39089) return 'Follow Pack';
      if (!isNaN(aKind)) return `Event (kind ${aKind})`;
      if (dTag) return `Event ${dTag}`;
    }
    const kTag = this.options.event.tags.find((t: string[]) => t[0] === 'k');
    if (kTag?.[1]) {
      const kKind = parseInt(kTag[1]);
      if (kKind === 30023) return 'Article';
      if (kKind === 32267) return 'App';
      if (kKind === 39089) return 'Follow Pack';
      if (!isNaN(kKind)) return `Event (kind ${kKind})`;
    }
    const eTags = this.options.event.tags.filter((t: string[]) => t[0] === 'e');
    const eTag = eTags[eTags.length - 1];
    const eTagId = eTag?.[1];
    if (eTagId) return `Event ${this.shortEventId(eTagId)}`;
    return '';
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

    // For poll votes, show placeholder (will fetch the poll question async)
    if (this.options.type === 'poll_vote') {
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
        // Find the e-tag referring to the replied-to note.
        // Priority: NIP-10 root marker → NIP-22 root (uppercase E) → NIP-10 reply marker →
        //           NIP-22 parent (lowercase e) / NIP-10 positional fallback.
        const eTag = this.options.event.tags.find((t: string[]) => t[0] === 'e' && t[3] === 'root') ||
                     this.options.event.tags.find((t: string[]) => t[0] === 'E') ||
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
              const tagPubkey = tag[1];
              if (!tagPubkey) continue;
              try {
                const profile = await this.userProfileService.getUserProfile(tagPubkey);
                profiles.set(tagPubkey, profile);
              } catch {}
            }

            // Truncate plain text FIRST, THEN resolve mentions with loaded profiles
            const truncatedPlain = content.length > 150 ? content.slice(0, 150) + '...' : content;
            const withMentions = npubToUsername(escapeHtml(truncatedPlain), 'html-multi', (hex) => profiles.get(hex) || null);

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

    // For reactions, zaps, and poll votes, fetch the referenced note content
    if (this.options.type === 'reaction' || this.options.type === 'zap' || this.options.type === 'poll_vote') {
      await this.loadReferencedNotePreview();
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
   * Load referenced note preview for reactions and zaps.
   * Always replaces the "Loading..." placeholder — falls back to a short
   * "Follow Pack" / "Event abc12345" label when fetch fails, so the UI never
   * stays stuck on "Loading...".
   */
  private async loadReferencedNotePreview(): Promise<void> {
    const previewElement = this.element.querySelector('.notification-item__preview');
    if (!previewElement) return;

    const setPreview = (text: string) => {
      previewElement.textContent = text;
    };
    const fallbackPreview = this.buildUnresolvedPreview();

    try {
      // Check for addressable event reference (a-tag) first — articles, follow packs, etc.
      const aTag = this.options.event.tags.find((t: string[]) => t[0] === 'a');
      if (aTag?.[1]) {
        const aKind = parseInt(aTag[1].split(':')[0] || '');
        const refEvent = await this.fetchAddressableEvent(aTag[1]);
        if (refEvent) {
          if (aKind === 32267) {
            const name = refEvent.tags.find((t: string[]) => t[0] === 'name')?.[1] || 'App';
            setPreview(`App: ${name}`);
          } else if (aKind === 39089) {
            const { parseFollowPackEvent } = await import('../../helpers/parseFollowPack');
            const pack = parseFollowPackEvent(refEvent);
            setPreview(`Follow Pack: ${pack.title}`);
          } else if (aKind === 30023) {
            const { LongFormOrchestrator } = await import('../../services/orchestration/LongFormOrchestrator');
            const metadata = LongFormOrchestrator.extractArticleMetadata(refEvent);
            setPreview(`Article: ${metadata.title}`);
          } else {
            const dTag = refEvent.tags.find((t: string[]) => t[0] === 'd')?.[1];
            setPreview(dTag ? `Event (kind ${aKind}): ${dTag}` : `Event (kind ${aKind})`);
          }
          return;
        }
        // addressable fetch failed → short, kind-aware fallback (never "Loading...")
        setPreview(fallbackPreview);
        return;
      }

      // For reactions/zaps, use the LAST e-tag (NIP-25: direct reference to reacted note)
      // Some clients copy all e-tags from the thread, but the last one is always the direct target
      const eTags = this.options.event.tags.filter((t: string[]) => t[0] === 'e');
      const eTag = eTags[eTags.length - 1];
      if (!eTag || !eTag[1]) {
        setPreview(fallbackPreview);
        return;
      }

      // Read k-tag hint: some clients reference addressable events (e.g. Follow Packs)
      // via e-tag + k-tag instead of a full a-tag coordinate. Using the hint lets us
      // include the non-default kind in the fetch filter so we can resolve the event.
      const kTag = this.options.event.tags.find((t: string[]) => t[0] === 'k');
      const kHint = kTag?.[1] ? parseInt(kTag[1]) : NaN;
      const originalEvent = await this.fetchOriginalNote(eTag[1], isNaN(kHint) ? undefined : kHint);
      if (originalEvent) {
        if (originalEvent.kind === 39089) {
          const { parseFollowPackEvent } = await import('../../helpers/parseFollowPack');
          const pack = parseFollowPackEvent(originalEvent);
          setPreview(`Follow Pack: ${pack.title}`);
          return;
        }
        if (originalEvent.kind === 30023) {
          const title = originalEvent.tags.find((t: string[]) => t[0] === 'title')?.[1] || 'Untitled';
          setPreview(`Article: ${title}`);
          return;
        }
        if (originalEvent.kind === 32267) {
          const name = originalEvent.tags.find((t: string[]) => t[0] === 'name')?.[1] || 'App';
          setPreview(`App: ${name}`);
          return;
        }
        if (originalEvent.kind === 1068) {
          const question = (originalEvent.content || '').trim();
          const snippet = question.length > 80 ? question.slice(0, 80) + '...' : question;
          setPreview(snippet ? `Poll: ${snippet}` : 'Poll');
          return;
        }
        if (originalEvent.content) {
          const maxLength = 100;
          const content = originalEvent.content;
          setPreview(content.length > maxLength
            ? content.slice(0, maxLength) + '...'
            : content);
          return;
        }
      }

      // e-tag fetch failed or unknown kind — show short-id fallback
      setPreview(fallbackPreview);
    } catch (error) {
      console.warn('Failed to fetch referenced note:', error);
      setPreview(fallbackPreview);
    }
  }

  /**
   * Get the referenced note ID from event tags (for zaps, reactions)
   * Uses the LAST e-tag as that's the direct reference (NIP-25)
   */
  private getReferencedNoteId(): string | null {
    const eTags = this.options.event.tags.filter((t: string[]) => t[0] === 'e');
    const eTag = eTags[eTags.length - 1];
    return eTag?.[1] || null;
  }

  /**
   * Handle notification click (navigate to note)
   */
  private async handleClick(e: MouseEvent): Promise<void> {
    // Don't navigate if clicking on ISL buttons
    const target = e.target as HTMLElement;
    if (target.closest('.isl, .isl-action')) {
      return;
    }

    const router = Router.getInstance();
    const type = this.options.type;

    // For zaps, reactions, and poll votes, navigate to referenced event
    if (type === 'zap' || type === 'reaction' || type === 'poll_vote') {
      // Check for addressable event reference (a-tag) — articles, follow packs, etc.
      const aTag = this.options.event.tags.find((t: string[]) => t[0] === 'a');
      if (aTag?.[1]) {
        const parts = aTag[1].split(':');
        if (parts.length >= 3) {
          const { encodeNaddr } = await import('../../services/NostrToolsAdapter');
          const kind = parseInt(parts[0]!);
          const naddr = encodeNaddr({
            kind,
            pubkey: parts[1]!,
            identifier: parts[2]!,
            relays: []
          });
          const { App } = await import('../../App');
          router.navigate(App.getRouteForAddressableEvent(kind, naddr));
          return;
        }
      }
      const noteId = this.getReferencedNoteId();
      if (noteId) {
        router.navigate(`/note/${noteId}`);
      }
      return;
    }

    // For reposts, navigate to original note
    if (type === 'repost') {
      const originalNoteId = extractOriginalNoteId(this.options.event);
      router.navigate(`/note/${originalNoteId}`);
      return;
    }

    // For articles, navigate to article view with naddr
    if (type === 'article') {
      const dTag = this.options.event.tags.find((t: string[]) => t[0] === 'd');
      if (dTag && dTag[1]) {
        router.navigate(`/article/${dTag[1]}`);
      }
      return;
    }

    // For hashtag notifications, navigate directly to the post
    if (type === 'hashtag') {
      router.navigate(`/note/${this.options.event.id}`);
      return;
    }

    // For mutual notifications, navigate to profile
    if (type === 'mutual_unfollow' || type === 'mutual_new') {
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
  private async fetchOriginalNote(noteId: string, kindHint?: number): Promise<NostrEvent | null> {
    const { NostrTransport } = await import('../../services/transport/NostrTransport');
    const transport = NostrTransport.getInstance();

    try {
      // Get read relays from config
      const readRelays = transport.getReadRelays();

      // Include the hinted kind (from k-tag) so we can resolve addressable
      // events — e.g. Follow Packs — that are referenced only via e-tag.
      const kinds = (typeof kindHint === 'number' && !isNaN(kindHint))
        ? Array.from(new Set([...USER_CONTENT_KINDS, kindHint]))
        : USER_CONTENT_KINDS;

      const events = await transport.fetch(
        readRelays,
        [{
          ids: [noteId],
          kinds,
          limit: 1
        }],
        5000,
        false,
        'NotifItem'
      );

      return events[0] || null;
    } catch (error) {
      console.error('[NotificationItem] Failed to fetch original note:', error);
      return null;
    }
  }

  /**
   * Fetch addressable event by a-tag coordinate (e.g. "30023:pubkey:identifier")
   */
  private async fetchAddressableEvent(coordinate: string): Promise<NostrEvent | null> {
    const { NostrTransport } = await import('../../services/transport/NostrTransport');
    const transport = NostrTransport.getInstance();

    try {
      const parts = coordinate.split(':');
      if (parts.length < 3) return null;

      const kind = parseInt(parts[0]!);
      const pubkey = parts[1]!;
      const identifier = parts[2]!;

      const readRelays = transport.getReadRelays();
      const events = await transport.fetch(
        readRelays,
        [{
          kinds: [kind],
          authors: [pubkey],
          '#d': [identifier],
          limit: 1
        }],
        5000,
        false,
        'NotifItem'
      );

      return events[0] || null;
    } catch (error) {
      console.error('[NotificationItem] Failed to fetch addressable event:', error);
      return null;
    }
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
