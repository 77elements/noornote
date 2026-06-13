/**
 * ZapsList Component
 * Displays horizontal list of zap badges (username + amount) above ISL in SNV
 * Sorted by amount (largest first), horizontally scrollable
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ZapsModuleApi } from '../../modules/zaps/contracts';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { extractZapperPubkey, extractZapMessage, getZapAmountSats, formatNumberWithCommas, isZapAnonymous } from '../../helpers/zapUtils';
import { UserHoverCard } from './UserHoverCard';

interface ZapData {
  zapperPubkey: string;
  username: string;
  amountSats: number;
  message: string;
  avatarUrl: string;
  isAnonymous: boolean;
  isOwn: boolean;
  /** The raw kind:9735 receipt — needed to reply (NIP-22 comment) to this zap. */
  event: NostrEvent;
}

export class ZapsList {
  private element: HTMLElement;
  private zapEvents: NostrEvent[];
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private _zapsApi?: ZapsModuleApi | null;
  private get zapsApi(): ZapsModuleApi | null {
    return this._zapsApi ??= ModuleLoader.getInstance().getApi<ZapsModuleApi>('zaps');
  }

  constructor(zapEvents: NostrEvent[]) {
    this.zapEvents = zapEvents;
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.element = this.createElement();
  }

  /**
   * Parse zap events and extract zapper info + amounts
   */
  private async parseZaps(): Promise<ZapData[]> {
    const zaps: ZapData[] = [];

    for (const event of this.zapEvents) {
      const anon = isZapAnonymous(event);

      if (anon) {
        // Distinguish OWN anonymous zaps (matched via bolt11 in local storage)
        // from anonymous zaps sent by others. Only the sender's own browser
        // can resolve this — other viewers see a generic lock badge.
        const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
        const isOwn = !!bolt11 && (this.zapsApi?.isOwnAnonZapInvoice(bolt11) ?? false);

        if (isOwn) {
          const currentUser = this.authService.getCurrentUser();
          const ownProfile = currentUser
            ? await this.userProfileService.getUserProfile(currentUser.pubkey)
            : null;
          zaps.push({
            zapperPubkey: currentUser?.pubkey || '',
            username: ownProfile?.display_name || ownProfile?.name || 'You',
            amountSats: getZapAmountSats(event),
            message: extractZapMessage(event),
            avatarUrl: ownProfile?.picture || '',
            isAnonymous: true,
            isOwn: true,
            event,
          });
        } else {
          // For anonymous zaps from others the embedded pubkey is a throwaway —
          // skip the profile lookup, render a lock badge instead.
          zaps.push({
            zapperPubkey: '',
            username: 'Anonymous',
            amountSats: getZapAmountSats(event),
            message: extractZapMessage(event),
            avatarUrl: '',
            isAnonymous: true,
            isOwn: false,
            event,
          });
        }
        continue;
      }

      const zapperPubkey = extractZapperPubkey(event);
      const profile = await this.userProfileService.getUserProfile(zapperPubkey);

      zaps.push({
        zapperPubkey,
        username: profile?.display_name || profile?.name || 'Anonymous',
        amountSats: getZapAmountSats(event),
        message: extractZapMessage(event),
        avatarUrl: profile?.picture || '',
        isAnonymous: false,
        isOwn: false,
        event,
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
      const badgeClasses = ['zaps-list__badge'];
      if (zap.isAnonymous && !zap.isOwn) badgeClasses.push('zaps-list__badge--anonymous');
      if (zap.isOwn) badgeClasses.push('zaps-list__badge--own-anonymous');
      badge.className = badgeClasses.join(' ');

      if (!zap.isAnonymous || zap.isOwn) {
        badge.dataset.zapperPubkey = zap.zapperPubkey;
      }

      const displayText = zap.message
        ? escapeHtml(zap.message)
        : `Zapped by ${escapeHtml(zap.username)}`;

      // Own anonymous zap: render OUR avatar + a small lock badge so the sender
      // can see at a glance "this was my secret zap" while other viewers see
      // only the lock-only badge.
      let avatarHtml: string;
      if (zap.isAnonymous && !zap.isOwn) {
        avatarHtml = `<span class="zaps-list__avatar zaps-list__avatar--anonymous"><svg width="20" height="20"><use href="#icon-lock"></use></svg></span>`;
      } else if (zap.isOwn) {
        const img = zap.avatarUrl
          ? `<img src="${escapeHtmlAttr(zap.avatarUrl)}" alt="${escapeHtml(zap.username)}" class="zaps-list__avatar" />`
          : `<span class="zaps-list__avatar"></span>`;
        avatarHtml = `<span class="zaps-list__own-anon">${img}<svg class="zaps-list__own-lock" width="12" height="12"><use href="#icon-lock"></use></svg></span>`;
      } else {
        avatarHtml = `<img src="${escapeHtmlAttr(zap.avatarUrl)}" alt="${escapeHtml(zap.username)}" class="zaps-list__avatar" />`;
      }

      badge.innerHTML = `
        ${avatarHtml}
        <span class="zaps-list__icon">⚡</span>
        <span class="zaps-list__amount">${formatNumberWithCommas(zap.amountSats)}</span>
        <span class="zaps-list__text">${displayText}</span>
      `;

      // Hover card is identity-bound: skip for anonymous (no identity to show);
      // for OWN anonymous show our own card.
      if (!zap.isAnonymous || zap.isOwn) {
        badge.addEventListener('mouseenter', () => {
          userHoverCard.show(zap.zapperPubkey, badge);
        });

        badge.addEventListener('mouseleave', () => {
          userHoverCard.hide();
        });
      }

      // Reply to a zap (NIP-22 comment on the kind:9735): only when the zapper is identifiable —
      // an anonymous zap has nobody to notify, and replying to your own zap makes no sense.
      if (!zap.isAnonymous) {
        badge.classList.add('zaps-list__badge--replyable');
        badge.title = `Reply to ${zap.username}'s zap`;
        badge.addEventListener('click', async (e) => {
          e.stopPropagation();
          userHoverCard.hide();
          const { ReplyModal } = await import('../reply/ReplyModal');
          await ReplyModal.getInstance().show(zap.event.id ?? '', zap.event);
        });
      }

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
