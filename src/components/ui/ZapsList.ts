/**
 * ZapsList Component
 * Displays horizontal list of zap badges (username + amount) above ISL in SNV
 * Sorted by amount (largest first), horizontally scrollable
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { UserProfileService } from '../../services/UserProfileService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { UserHoverCard } from './UserHoverCard';

interface ZapData {
  zapperPubkey: string;
  username: string;
  amountSats: number;
  message: string;
  avatarUrl: string;
}

export class ZapsList {
  private element: HTMLElement;
  private zapEvents: NostrEvent[];
  private userProfileService: UserProfileService;

  constructor(zapEvents: NostrEvent[]) {
    this.zapEvents = zapEvents;
    this.userProfileService = UserProfileService.getInstance();
    this.element = this.createElement();
  }

  /**
   * Parse zap events and extract zapper info + amounts
   */
  private async parseZaps(): Promise<ZapData[]> {
    const zaps: ZapData[] = [];

    for (const event of this.zapEvents) {
      // Extract actual zapper pubkey from description tag (zap request)
      const descTag = event.tags.find(tag => tag[0] === 'description');
      let zapperPubkey = event.pubkey;
      let zapMessage = '';

      if (descTag && descTag[1]) {
        try {
          const zapRequest = JSON.parse(descTag[1]);
          if (zapRequest.pubkey) {
            zapperPubkey = zapRequest.pubkey;
          }
          zapMessage = zapRequest.content || '';
        } catch (e) {
          // Use fallback pubkey
        }
      }

      // Fetch profile for username and photo
      const profile = await this.userProfileService.getUserProfile(zapperPubkey);
      const username = profile?.display_name || profile?.name || 'Anonymous';
      const avatarUrl = profile?.picture || '';
      const bolt11Tag = event.tags.find(tag => tag[0] === 'bolt11');
      const bolt11Value = bolt11Tag?.[1];
      const amountSats = bolt11Value ? this.parseBolt11Amount(bolt11Value) : 0;

      zaps.push({
        zapperPubkey,
        username,
        amountSats,
        message: zapMessage,
        avatarUrl
      });
    }

    // Sort by amount (largest first)
    zaps.sort((a, b) => b.amountSats - a.amountSats);

    return zaps;
  }

  /**
   * Parse bolt11 invoice to get amount in sats
   * Based on AnalyticsModal.parseBolt11Amount()
   */
  private parseBolt11Amount(invoice: string): number {
    try {
      const match = invoice.match(/^ln(bc|tb)(\d+)([munp]?)/i);
      const amountStr = match?.[2];
      if (!amountStr) return 0;

      const amount = parseInt(amountStr);
      const multiplier = match[3]?.toLowerCase();

      let millisats = 0;
      switch (multiplier) {
        case 'm': millisats = amount * 100_000_000; break;
        case 'u': millisats = amount * 100_000; break;
        case 'n': millisats = amount * 100; break;
        case 'p': millisats = amount * 0.1; break;
        default: millisats = amount * 100_000_000_000; break;
      }

      return Math.floor(millisats / 1000);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Format number with comma thousands separator (US format)
   */
  private formatNumber(num: number): string {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * Create ZapsList element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'zaps-list';

    // Render async (profiles need to be fetched)
    this.renderAsync(container);

    return container;
  }

  /**
   * Render ZapsList asynchronously (fetch profiles first)
   */
  private async renderAsync(container: HTMLElement): Promise<void> {
    const zaps = await this.parseZaps();

    if (zaps.length === 0) {
      container.style.display = 'none';
      return;
    }

    // Create scrollable inner container
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'zaps-list__scroll';

    // Create zap badges (photo + amount + comment)
    const userHoverCard = UserHoverCard.getInstance();

    zaps.forEach(zap => {
      const badge = document.createElement('div');
      badge.className = 'zaps-list__badge';
      badge.dataset.zapperPubkey = zap.zapperPubkey; // Store pubkey for hover card

      // Build display text: "⚡ {amount} {comment or username}"
      const displayText = zap.message
        ? escapeHtml(zap.message)
        : `Zapped by ${escapeHtml(zap.username)}`;

      badge.innerHTML = `
        <img src="${zap.avatarUrl}" alt="${escapeHtml(zap.username)}" class="zaps-list__avatar" />
        <span class="zaps-list__icon">⚡</span>
        <span class="zaps-list__amount">${this.formatNumber(zap.amountSats)}</span>
        <span class="zaps-list__text">${displayText}</span>
      `;

      // Add hover card listeners for avatar and badge
      badge.addEventListener('mouseenter', () => {
        userHoverCard.show(zap.zapperPubkey, badge);
      });

      badge.addEventListener('mouseleave', () => {
        userHoverCard.hide();
      });

      scrollContainer.appendChild(badge);
    });

    container.appendChild(scrollContainer);
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Destroy component
   */
  public destroy(): void {
    this.element.remove();
  }
}
