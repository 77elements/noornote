/**
 * ZapsList Component
 * Displays horizontal list of zap badges (username + amount) above ISL in SNV
 * Sorted by amount (largest first), horizontally scrollable
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { UserProfileService } from '../../services/UserProfileService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { extractZapperPubkey, extractZapMessage, getZapAmountSats, formatNumberWithCommas } from '../../helpers/zapUtils';
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
      const zapperPubkey = extractZapperPubkey(event);
      const profile = await this.userProfileService.getUserProfile(zapperPubkey);

      zaps.push({
        zapperPubkey,
        username: profile?.display_name || profile?.name || 'Anonymous',
        amountSats: getZapAmountSats(event),
        message: extractZapMessage(event),
        avatarUrl: profile?.picture || ''
      });
    }

    zaps.sort((a, b) => b.amountSats - a.amountSats);
    return zaps;
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'zaps-list';
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

    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'zaps-list__scroll';

    const userHoverCard = UserHoverCard.getInstance();

    for (const zap of zaps) {
      const badge = document.createElement('div');
      badge.className = 'zaps-list__badge';
      badge.dataset.zapperPubkey = zap.zapperPubkey;

      const displayText = zap.message
        ? escapeHtml(zap.message)
        : `Zapped by ${escapeHtml(zap.username)}`;

      badge.innerHTML = `
        <img src="${zap.avatarUrl}" alt="${escapeHtml(zap.username)}" class="zaps-list__avatar" />
        <span class="zaps-list__icon">⚡</span>
        <span class="zaps-list__amount">${formatNumberWithCommas(zap.amountSats)}</span>
        <span class="zaps-list__text">${displayText}</span>
      `;

      badge.addEventListener('mouseenter', () => {
        userHoverCard.show(zap.zapperPubkey, badge);
      });

      badge.addEventListener('mouseleave', () => {
        userHoverCard.hide();
      });

      scrollContainer.appendChild(badge);
    }

    container.appendChild(scrollContainer);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.element.remove();
  }
}
