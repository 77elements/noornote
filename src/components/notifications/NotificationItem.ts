/**
 * NotificationItem Component
 * Single notification card with icon, author info, action text, and preview
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { NotificationType } from '../../services/orchestration/NotificationsOrchestrator';
import { USER_CONTENT_KINDS } from '../../types/nostr';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { TypedEventBus } from '../../core/TypedEventBus';
import { hexToNpub } from '../../helpers/nip19';
import { InteractionStatusLine } from '../ui/InteractionStatusLine';
import { ZapsList } from '../ui/ZapsList';
import { AuthService } from '../../services/AuthService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import { UserIdentity } from '../shared/UserIdentity';
import { resolveQuotedContent } from '../../helpers/resolveQuotedContent';
import { extractOriginalNoteId } from '../../helpers/extractOriginalNoteId';
import { getRepostsOriginalEvent } from '../../helpers/getRepostsOriginalEvent';
import { npubToUsername } from '../../helpers/npubToUsername';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { resolveReactionEmoji } from '../../helpers/formatCustomEmojis';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { getZapAmountSats, extractZapMessage, formatNumberWithCommas } from '../../helpers/zapUtils';

export interface NotificationItemOptions {
  event: NostrEvent;
  type: NotificationType;
  timestamp: number;
  meta?: { hashtag?: string; count?: number; groupName?: string; isOwn?: boolean; groupRelay?: string };
}

export class NotificationItem {
  private element: HTMLElement;
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return this._reactionsApi ??= ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
  }
  private options: NotificationItemOptions;
  private userIdentity: UserIdentity | null = null;
  private isl: InteractionStatusLine | null = null;
  private zapsList: ZapsList | null = null;

  constructor(options: NotificationItemOptions) {
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
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
    const needsContext = this.options.type === 'reply' || this.options.type === 'mention' || this.options.type === 'thread-reply' || this.options.type === 'zap-reply';
    const contextHtml = needsContext ? '<div class="thread-context-item"><span class="thread-context-content">Loading...</span></div>' : '';

    // For badge-award notifications, add Accept/Decline buttons
    const badgeFooterHtml = this.options.type === 'badge-award'
      ? `<div class="notification-item__footer">
          <button class="btn btn--mini btn--success" data-action="accept-badge">Accept</button>
          <button class="btn btn--mini btn--secondary" data-action="decline-badge">Decline</button>
        </div>`
      : '';

    // For hashtag notifications, add footer with search and unsubscribe links
    const hashtag = this.options.meta?.hashtag;
    const hashtagFooterHtml = this.options.type === 'hashtag' && hashtag
      ? `<div class="notification-item__footer">
          <a href="#" class="notification-item__footer-link notification-item__footer-link--search" data-hashtag="${escapeHtmlAttr(hashtag)}">Open notes tagged #${escapeHtml(hashtag)}</a>
          <a href="#" class="notification-item__footer-link notification-item__footer-link--unsubscribe" data-hashtag="${escapeHtmlAttr(hashtag)}">Unsubscribe from #${escapeHtml(hashtag)}</a>
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
        ${badgeFooterHtml}
        ${hashtagFooterHtml}
      </div>
    `;

    // Insert UserIdentity component (anonymized for poll votes + anonymous zaps)
    const identityContainer = item.querySelector('.notification-item__user-identity');
    if (identityContainer) {
      if (this.options.type === 'dhikr_round' || this.options.type === 'dhikr_commit'
          || this.options.type === 'dhikr_complete' || this.options.type === 'nostrord') {
        // Community dhikr + Nostrord notifications are anonymous by design — no author at all.
        // The action text is self-contained ("Someone posted to …"), so drop the identity slot.
        identityContainer.remove();
      } else if (this.options.type === 'poll_vote') {
        // NIP-88 votes: don't expose the voter — show neutral "Someone" instead.
        identityContainer.innerHTML = '<span class="notification-item__anonymous">Someone</span>';
      } else if (this.isAnonymousZap()) {
        // Anonymous zap: the embedded pubkey is an ephemeral throwaway, so we
        // don't render it. Lock icon + "Someone" makes the secret nature
        // obvious; the actual npub is only available via diagnostic logs.
        identityContainer.innerHTML =
          '<span class="notification-item__anonymous">' +
          '<svg width="14" height="14" aria-hidden="true"><use href="#icon-lock"></use></svg>' +
          'Someone</span>';
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

    // Setup badge accept/decline handlers
    this.setupBadgeActions(item);

    // Async-upgrade badge-award notification text with the badge name
    if (this.options.type === 'badge-award') {
      this.upgradeBadgeActionText(item);
    }

    // Setup hashtag footer link handlers
    this.setupHashtagFooterLinks(item);

    return item;
  }

  /**
   * Setup click handlers for hashtag footer links
   */
  private setupBadgeActions(item: HTMLElement): void {
    const acceptBtn = item.querySelector('[data-action="accept-badge"]');
    const declineBtn = item.querySelector('[data-action="decline-badge"]');
    if (!acceptBtn && !declineBtn) return;

    acceptBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { BadgeService } = await import('../../addons/badges/BadgeService');
      const service = BadgeService.getInstance();
      const event = this.options.event;
      const aTag = event.tags.find((t: string[]) => t[0] === 'a')?.[1];
      if (!aTag || !event.id) return;
      const success = await service.acceptBadge(aTag, event.id);
      if (success) {
        const footer = (e.target as HTMLElement).closest('.notification-item__footer');
        if (footer) footer.innerHTML = '<span style="color: var(--color-6)">Accepted</span>';
      }
    });

    declineBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const footer = (e.target as HTMLElement).closest('.notification-item__footer');
      if (footer) footer.innerHTML = '<span style="color: var(--color-3)">Declined</span>';
    });
  }

  private upgradeBadgeActionText(item: HTMLElement): void {
    const aTag = this.options.event.tags.find((t: string[]) => t[0] === 'a')?.[1];
    if (!aTag) return;
    import('../../services/orchestration/BadgeOrchestrator').then(({ BadgeOrchestrator }) => {
      BadgeOrchestrator.getInstance().fetchBadgeDefinition(aTag).then(def => {
        if (!def) return;
        const actionEl = item.querySelector('.notification-item__action');
        if (actionEl) actionEl.textContent = `awarded you a "${def.name}" badge`;
      }).catch(() => {});
    });
  }

  private setupHashtagFooterLinks(item: HTMLElement): void {
    // Search link - opens hashtag search in scc
    const searchLink = item.querySelector('.notification-item__footer-link--search');
    if (searchLink) {
      searchLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hashtag = (searchLink as HTMLElement).dataset.hashtag;
        if (hashtag) {
          const eventBus = TypedEventBus.getInstance();
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
    return type === 'mention' || type === 'reply' || type === 'thread-reply' || type === 'zap-reply' || type === 'highlight';
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
    const stats = await this.reactionsApi?.getDetailedStats(eventId);

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
      case 'zap-reply':
        return `<svg width="18" height="18"><use href="#icon-thread-bubble"/></svg>`;

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

      case 'follower_new':
        return '👤';

      case 'highlight':
        return `<svg width="18" height="18"><use href="#icon-highlight"/></svg>`;

      case 'badge-award':
        return `<svg width="18" height="18"><use href="#icon-badge"/></svg>`;

      case 'dhikr_complete':
        return '🎉';

      case 'dhikr_round':
      case 'dhikr_commit':
        return '📿';

      case 'nostrord':
        return '💬';

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
      if (kind === 30030) return 'emoji pack';
      if (kind === 30617) return 'git repository';
      if (!isNaN(kind)) return 'event';
    }
    const kTag = this.options.event.tags.find((t: string[]) => t[0] === 'k');
    if (kTag?.[1]) {
      const kind = parseInt(kTag[1]);
      if (kind === 7) return 'reaction';
      if (kind === 9735) return 'zap';
      if (kind === 1063) return 'file';
      if (kind === 20) return 'picture';
      if (kind === 21 || kind === 22) return 'video';
      if (kind === 1068) return 'poll';
      if (kind === 30023) return 'article';
      if (kind === 32267) return 'app on Zapstore';
      if (kind === 39089) return 'follow pack';
      if (kind === 30030) return 'emoji pack';
      if (kind === 1617) return 'git patch';
      if (kind === 1618 || kind === 1619) return 'pull request';
      if (kind === 1621) return 'git issue';
      if (kind === 1630 || kind === 1631 || kind === 1632 || kind === 1633) return 'git status update';
      if (kind === 30617) return 'git repository';
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
      case 'zap-reply': return 'replied to your zap';
      case 'repost': return `reposted your ${target}`;
      case 'reaction': return `reacted to your ${target}`;
      case 'zap': {
        const amount = this.getZapAmount();
        const verb = this.isAnonymousZap() ? 'silently zapped' : 'zapped';
        return amount
          ? `${verb} your ${target} <span class="notification-item__zap-amount">${amount.toLocaleString()} sats</span>`
          : `${verb} your ${target}`;
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
      case 'follower_new': return 'is now following you';
      case 'nostrord': {
        const name = this.options.meta?.groupName;
        const where = name ? `the Nostrord group "${name}"` : 'a Nostrord group';
        return this.options.meta?.isOwn ? `You posted to ${where}` : `Someone posted to ${where}`;
      }
      case 'highlight': return `highlighted your ${target}`;
      case 'badge-award': return 'awarded you a badge';
      case 'dhikr_round': return 'Somebody started a new dhikr';
      case 'dhikr_commit': return 'Somebody committed to a dhikr';
      case 'dhikr_complete': return 'A dhikr reached its goal';
      default: return `interacted with your ${target}`;
    }
  }

  /**
   * Detect whether a kind:9735 zap receipt's embedded zap request carries an
   * `anon` tag — anonymous zap (PR #1271 / Damus / Amethyst / Wisp convention).
   * The pubkey on the embedded request is then an ephemeral throwaway and the
   * UI should render a generic "Someone" + lock instead.
   */
  private isAnonymousZap(): boolean {
    if (this.options.type !== 'zap') return false;
    const descTag = this.options.event.tags.find((t: string[]) => t[0] === 'description');
    if (!descTag?.[1]) return false;
    try {
      const zapRequest = JSON.parse(descTag[1]);
      return Array.isArray(zapRequest.tags)
        && zapRequest.tags.some((t: string[]) => t[0] === 'anon');
    } catch {
      return false;
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
      if (aKind === 30030) return 'Emoji Pack';
      if (!isNaN(aKind)) return `Event (kind ${aKind})`;
      if (dTag) return `Event ${dTag}`;
    }
    const kTag = this.options.event.tags.find((t: string[]) => t[0] === 'k');
    if (kTag?.[1]) {
      const kKind = parseInt(kTag[1]);
      if (kKind === 30023) return 'Article';
      if (kKind === 32267) return 'App';
      if (kKind === 39089) return 'Follow Pack';
      if (kKind === 30030) return 'Emoji Pack';
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
    // For mutual / follower notifications, no preview needed
    if (this.options.type === 'mutual_unfollow' || this.options.type === 'mutual_new'
        || this.options.type === 'follower_new'
        || this.options.type === 'dhikr_round' || this.options.type === 'dhikr_commit'
        || this.options.type === 'dhikr_complete' || this.options.type === 'nostrord') {
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
    if (this.options.type === 'reply' || this.options.type === 'mention' || this.options.type === 'thread-reply' || this.options.type === 'zap-reply') {
      const contextElement = this.element.querySelector('.thread-context-content');
      // Resolve the "Loading…" placeholder in EVERY path — never leave it stuck (e.g. when the
      // parent event can't be fetched from our read relays, which is common for zap receipts).
      const hideContext = () => {
        const item = this.element.querySelector('.thread-context-item');
        if (item) (item as HTMLElement).style.display = 'none';
      };
      try {
        // NIP-22: the reply's own K/k tag names the parent kind without us having to fetch it —
        // so we can label a zap thread even when the 9735 receipt isn't on our relays.
        const parentIsZap = this.options.event.tags.some((t: string[]) => (t[0] === 'K' || t[0] === 'k') && t[1] === '9735');

        // Find the e-tag referring to the replied-to note.
        // Priority: NIP-10 root marker → NIP-22 root (uppercase E) → NIP-10 reply marker →
        //           NIP-22 parent (lowercase e) / NIP-10 positional fallback.
        const eTag = this.options.event.tags.find((t: string[]) => t[0] === 'e' && t[3] === 'root') ||
                     this.options.event.tags.find((t: string[]) => t[0] === 'E') ||
                     this.options.event.tags.find((t: string[]) => t[0] === 'e' && t[3] === 'reply') ||
                     this.options.event.tags.find((t: string[]) => t[0] === 'e');

        const originalEvent = eTag?.[1] ? await this.fetchOriginalNote(eTag[1]) : null;

        if (parentIsZap || originalEvent?.kind === 9735) {
          // A zap receipt carries no content. Show "⚡ N sats" if we could fetch it, otherwise a
          // generic label so the row still reads as a reply to a zap (never "Loading…").
          if (contextElement) {
            if (originalEvent?.kind === 9735) {
              const amount = getZapAmountSats(originalEvent);
              const msg = extractZapMessage(originalEvent);
              const msgPart = msg ? ` "${msg.length > 80 ? msg.slice(0, 80) + '…' : msg}"` : '';
              contextElement.textContent = `⚡ ${formatNumberWithCommas(amount)} sats${msgPart}`;
            } else {
              contextElement.textContent = '⚡ a zap';
            }
          }
        } else if (originalEvent && originalEvent.content) {
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

          if (contextElement) contextElement.innerHTML = withMentions;
        } else {
          // Nothing fetchable / no content — drop the placeholder instead of showing "Loading…".
          hideContext();
        }
      } catch (error) {
        console.warn('Failed to fetch replied-to note:', error);
        hideContext();
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
        // Empty-content addressable events (e.g. emoji packs) need a kind-aware label.
        if (originalEvent.kind === 30030) {
          const { parseEmojiPackEvent } = await import('../../helpers/parseEmojiPack');
          const previewElement = this.element.querySelector('.notification-item__preview');
          if (previewElement) previewElement.textContent = `Emoji Pack: ${parseEmojiPackEvent(originalEvent).title}`;
          return;
        }
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
          } else if (aKind === 30030) {
            const { parseEmojiPackEvent } = await import('../../helpers/parseEmojiPack');
            setPreview(`Emoji Pack: ${parseEmojiPackEvent(refEvent).title}`);
          } else if (aKind === 30023) {
            const articlesApi = ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
            const metadata = articlesApi?.extractArticleMetadata(refEvent);
            setPreview(`Article: ${metadata?.title ?? 'Untitled'}`);
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
        if (originalEvent.kind === 30030) {
          const { parseEmojiPackEvent } = await import('../../helpers/parseEmojiPack');
          setPreview(`Emoji Pack: ${parseEmojiPackEvent(originalEvent).title}`);
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
        if (originalEvent.kind === 30617) {
          const name = originalEvent.tags.find((t: string[]) => t[0] === 'name')?.[1] || 'Repo';
          setPreview(`Git Repository: ${name}`);
          return;
        }
        if (originalEvent.kind === 1617 || originalEvent.kind === 1618 || originalEvent.kind === 1619 || originalEvent.kind === 1621) {
          const subject = originalEvent.tags.find((t: string[]) => t[0] === 'subject')?.[1];
          const label = originalEvent.kind === 1617 ? 'Git Patch'
                      : originalEvent.kind === 1621 ? 'Git Issue'
                      : 'Pull Request';
          setPreview(subject ? `${label}: ${subject}` : label);
          return;
        }
        if (originalEvent.kind === 1630 || originalEvent.kind === 1631 || originalEvent.kind === 1632 || originalEvent.kind === 1633) {
          const status = originalEvent.kind === 1630 ? 'Open'
                       : originalEvent.kind === 1631 ? 'Applied/Merged'
                       : originalEvent.kind === 1632 ? 'Closed'
                       : 'Draft';
          setPreview(`Git Status: ${status}`);
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
          const route = App.getRouteForAddressableEvent(kind, naddr);
          // Articles have a secondary-pane view; route them through the controller so
          // right-pane mode opens them in the scc. Other addressable kinds (zapstore,
          // follow-pack, ...) have no scc tab view yet and keep full Router navigation.
          if (route.startsWith('/article/')) {
            getViewNavigationController().openView('article', naddr, e);
          } else if (route.startsWith('/follow-pack/')) {
            getViewNavigationController().openView('follow-pack', naddr, e);
          } else if (route.startsWith('/listing/')) {
            getViewNavigationController().openView('listing', naddr, e);
          } else {
            router.navigate(route);
          }
          return;
        }
      }
      const noteId = this.getReferencedNoteId();
      if (noteId) {
        getViewNavigationController().openView('single-note', noteId, e);
      }
      return;
    }

    // For reposts, navigate to original note
    if (type === 'repost') {
      const originalNoteId = extractOriginalNoteId(this.options.event);
      if (originalNoteId) {
        getViewNavigationController().openView('single-note', originalNoteId, e);
      }
      return;
    }

    // For articles, navigate to article view with naddr
    if (type === 'article') {
      const dTag = this.options.event.tags.find((t: string[]) => t[0] === 'd');
      if (dTag && dTag[1]) {
        getViewNavigationController().openView('article', dTag[1], e);
      }
      return;
    }

    // For hashtag notifications, navigate directly to the post
    if (type === 'hashtag') {
      getViewNavigationController().openView('single-note', this.options.event.id, e);
      return;
    }

    // For mutual / follower notifications, navigate to profile
    if (type === 'mutual_unfollow' || type === 'mutual_new'
        || type === 'follower_new') {
      const npub = hexToNpub(this.options.event.pubkey);
      if (npub) {
        getViewNavigationController().openView('profile', npub, e);
      }
      return;
    }

    // For community-dhikr notifications, open the addon's Community Dhikr tab
    if (type === 'dhikr_round' || type === 'dhikr_commit' || type === 'dhikr_complete') {
      router.navigate('/addons/nostr-majlis/dhikr');
      return;
    }

    // NoorNote has no NIP-29 group view; open the group in the Nostrord web client (external,
    // user-initiated) in a new tab. Group id lives in the synthetic event's `h` tag, the relay
    // host in meta.
    if (type === 'nostrord') {
      const groupId = this.options.event.tags.find(t => t[0] === 'h')?.[1];
      const relayHost = this.options.meta?.groupRelay;
      if (groupId && relayHost) {
        window.open(`https://web.nostrord.com/#/g/${relayHost}/${groupId}`, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    // Default: navigate to the notification event itself
    getViewNavigationController().openView('single-note', this.options.event.id, e);
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
