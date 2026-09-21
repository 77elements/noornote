/**
 * ZapsList Component
 * Displays horizontal list of zap badges (username + amount) above ISL in SNV
 * Sorted by amount (largest first), horizontally scrollable
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ZapPendingState } from '../../services/ZapService';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ZapsModuleApi } from '../../modules/zaps/contracts';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import {
  buildZapReactionEntries,
  extractZapperPubkey,
  extractZapMessage,
  getZapAmountSats,
  formatNumberWithCommas,
  isZapAnonymous,
} from '../../helpers/zapUtils';
import { UserHoverCard } from './UserHoverCard';
import { Tooltip } from './Tooltip';
import { NnDropdown } from './NnDropdown';
import { TypedEventBus } from '../../core/TypedEventBus';
import type { CustomEmojiEntry } from '../emoji/EmojiPicker';
import { AuthGuard } from '../../services/AuthGuard';
import { isCustomEmojisEnabled } from '../../addons/custom-emojis/index';

interface ZapData {
  zapperPubkey: string;
  username: string;
  amountSats: number;
  message: string;
  avatarUrl: string;
  isAnonymous: boolean;
  isOwn: boolean;
  /** The raw kind:9735 receipt — needed to reply (NIP-22 comment) to this zap.
   *  Optimistic lifecycle rows have none (not replyable until it arrives). */
  event?: NostrEvent;
}

export class ZapsList {
  private element: HTMLElement;
  private zapEvents: NostrEvent[];
  private pendingStates: ZapPendingState[];
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private _zapsApi?: ZapsModuleApi | null;
  private get zapsApi(): ZapsModuleApi | null {
    return (this._zapsApi ??=
      ModuleLoader.getInstance().getApi<ZapsModuleApi>('zaps'));
  }
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return (this._reactionsApi ??=
      ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions'));
  }
  private _postsApi?: PostsModuleApi | null;
  private get postsApi(): PostsModuleApi | null {
    return (this._postsApi ??=
      ModuleLoader.getInstance().getApi<PostsModuleApi>('posts'));
  }
  /** Open zap-pill pulldowns — torn down with the list (destroy contract). */
  private dropdowns: NnDropdown[] = [];
  /** Receipt id → pill, for instant reaction-hint updates. */
  private receiptBadges = new Map<string, HTMLElement>();
  /** TypedEventBus subscription ids (reactions added/removed on shown zaps). */
  private busIds: string[] = [];

  constructor(zapEvents: NostrEvent[], pendingStates: ZapPendingState[] = []) {
    this.zapEvents = zapEvents;
    this.pendingStates = pendingStates;
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.element = this.createElement();
    const bus = TypedEventBus.getInstance();
    this.busIds = [
      bus.on('reactions:added', (payload: { noteId: string }) =>
        this.onBusInteraction(payload)
      ),
      bus.on('reactions:removed', (payload: { noteId: string }) =>
        this.onBusInteraction(payload)
      ),
    ];
  }

  /**
   * Parse zap events and extract zapper info + amounts
   */
  private async parseZaps(): Promise<ZapData[]> {
    const zaps: ZapData[] = [];
    // One payment = one bolt11: zappers occasionally publish a receipt RETRY
    // (re-signed → different event id, same payment) — render it once.
    const seenReceiptInvoices = new Set<string>();

    for (const event of this.zapEvents) {
      const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
      if (bolt11) {
        if (seenReceiptInvoices.has(bolt11)) continue;
        seenReceiptInvoices.add(bolt11);
      }
      const anon = isZapAnonymous(event);

      if (anon) {
        // Distinguish OWN anonymous zaps (matched via bolt11 in local storage)
        // from anonymous zaps sent by others. Only the sender's own browser
        // can resolve this — other viewers see a generic lock badge.
        const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
        const isOwn =
          !!bolt11 && (this.zapsApi?.isOwnAnonZapInvoice(bolt11) ?? false);

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
      const profile =
        await this.userProfileService.getUserProfile(zapperPubkey);

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

    // Optimistic lifecycle entries (ZapService authority): own zaps whose
    // receipt has not shown up yet. They flow through the SAME ZapData path
    // as receipt rows — identical markup, no invented pending styling. A
    // receipt whose bolt11 matches a pending invoice wins (no duplicate).
    for (const entry of this.pendingStates) {
      if (entry.invoice && seenReceiptInvoices.has(entry.invoice)) continue;
      const currentUser = this.authService.getCurrentUser();
      const ownProfile = currentUser
        ? await this.userProfileService.getUserProfile(currentUser.pubkey)
        : null;
      zaps.push({
        zapperPubkey: currentUser?.pubkey || '',
        username: ownProfile?.display_name || ownProfile?.name || 'You',
        amountSats: entry.amount,
        message: entry.comment ?? '',
        avatarUrl: ownProfile?.picture || '',
        isAnonymous: !!entry.anonymous,
        isOwn: !!entry.anonymous,
      });
    }

    zaps.sort((a, b) => b.amountSats - a.amountSats);
    return zaps;
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'zaps-list';
    void this.renderAsync(container);
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

    // Replyable zaps whose comment count we'll fetch to show a thread badge.
    // `anchor` is the pill's dropdown container — thread badges insert after it.
    const replyables: { zap: ZapData; anchor: HTMLElement }[] = [];
    // Receipt pills for the tiny reaction-hint overlay (reactions on the zap)
    this.receiptBadges = new Map<string, HTMLElement>();

    for (const zap of zaps) {
      const badge = document.createElement('div');
      const badgeClasses = ['zaps-list__badge'];
      if (zap.isAnonymous && !zap.isOwn)
        badgeClasses.push('zaps-list__badge--anonymous');
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

      // Receipt pill → eligible for the reaction-hint overlay
      if (zap.event?.id) this.receiptBadges.set(zap.event.id, badge);

      // Receipt pills open the zap pulldown (LikesList emoji-menu pattern):
      // the pill is the trigger. Options: "React to Zap" (always — reacting
      // needs no identity) and "Reply to Zap" (identifiable zapper only).
      if (zap.event) {
        badge.classList.add('zaps-list__badge--menu');
        badge.title = zap.isAnonymous
          ? 'React to this zap'
          : `React to or reply to ${zap.username}'s zap`;

        const options = zap.isAnonymous
          ? [{ value: 'react', label: '❤️ React to Zap' }]
          : [
              { value: 'react', label: '❤️ React to Zap' },
              {
                value: 'reply',
                label:
                  '<svg width="14" height="14" style="display: inline;"><use href="#icon-reply"/></svg> Reply to Zap',
              },
            ];
        const dd = new NnDropdown({
          options,
          selectedValue: '',
          className: 'zap-menu',
          menuPortal: true,
          onChange: value => {
            userHoverCard.hide();
            if (value === 'react') void this.reactToZap(zap, dd.getElement());
            else if (value === 'reply') void this.replyToZap(zap);
          },
        });
        this.dropdowns.push(dd);

        const menuEl = dd.getElement();
        const trigger = menuEl.querySelector('.nn-dropdown__trigger');
        if (trigger) {
          // Drop the default arrow — the pill IS the affordance.
          trigger.innerHTML = '';
          trigger.appendChild(badge);
        }
        scrollContainer.appendChild(menuEl);
        replyables.push({ zap, anchor: menuEl });
        continue;
      }

      scrollContainer.appendChild(badge);
    }

    container.appendChild(scrollContainer);

    // Show a thread badge ("T2") next to each zap that already has kind:1111
    // comments, so anyone — not just the zapper via their notification — can
    // open the zap's reply thread.
    void this.injectThreadBadges(replyables, userHoverCard);

    // Tiny reaction overlay ("💜2👍") bottom-right on pills whose zap receipt
    // has kind:7 reactions — one batched relay round-trip for all receipts.
    void this.injectReactionHints();
  }

  /**
   * Batch-fetch stats for every receipt pill and append a tiny emoji overlay
   * to those with reactions. Fire-and-forget: a later list rebuild (lifecycle
   * events) simply re-runs it — batchFetchStats serves cached ids for free.
   */
  private async injectReactionHints(): Promise<void> {
    const receiptBadges = this.receiptBadges;
    if (receiptBadges.size === 0) return;
    const ids = [...receiptBadges.keys()];
    try {
      await this.reactionsApi?.batchFetchStats(ids);
    } catch {
      return;
    }
    for (const [receiptId, badge] of receiptBadges) {
      this.appendHint(receiptId, badge);
    }
  }

  /**
   * Rebuild one pill's reaction hint from the detailed-stats cache (already
   * updated by publishReaction/removeReaction before the bus event fires).
   */
  private appendHint(receiptId: string, badge: HTMLElement): void {
    if (!badge.isConnected) return;
    badge.querySelector('.zaps-list__reaction-hint')?.remove();
    const stats = this.reactionsApi?.peekDetailedStats(receiptId);
    const entries = buildZapReactionEntries(stats?.reactionEvents ?? []);
    if (entries.length === 0) return;
    // Group identical emojis with a count: "💜2👍" instead of "💜💜👍"
    const groups = new Map<string, number>();
    for (const entry of entries) {
      groups.set(entry.emojiHtml, (groups.get(entry.emojiHtml) ?? 0) + 1);
    }
    const hint = document.createElement('span');
    hint.className = 'zaps-list__reaction-hint';
    hint.title = 'Reactions on this zap';
    hint.innerHTML = [...groups.entries()]
      .map(([emoji, count]) =>
        count > 1
          ? `${emoji}<span class="zaps-list__reaction-count">${count}</span>`
          : emoji
      )
      .join('');
    badge.appendChild(hint);
  }

  /**
   * Own react/un-react on a zap shown in THIS list: refresh that pill's hint
   * instantly (state changes are visible immediately — never on reload only).
   * Self-detaches once the list is gone (list rebuilds replace the instance).
   */
  private onBusInteraction = (payload: { noteId: string }): void => {
    if (!this.element.isConnected) {
      this.detachBus();
      return;
    }
    const badge = this.receiptBadges.get(payload.noteId);
    if (badge) this.appendHint(payload.noteId, badge);
  };

  private detachBus(): void {
    const bus = TypedEventBus.getInstance();
    this.busIds.forEach(id => bus.off(id));
    this.busIds = [];
  }

  /**
   * Fetch how many comments each replyable zap has (one batched request) and,
   * for those with at least one, insert a sibling "T{n}" badge that opens the
   * zap's thread (the zap as root note + its kind:1111 comments below).
   */
  private async injectThreadBadges(
    replyables: { zap: ZapData; anchor: HTMLElement }[],
    userHoverCard: UserHoverCard
  ): Promise<void> {
    if (replyables.length === 0) return;

    const zapIds = replyables
      .map(r => r.zap.event?.id)
      .filter((id): id is string => !!id);
    const counts = await this.reactionsApi?.getZapReplyCounts(zapIds);
    if (!counts || counts.size === 0) return;

    for (const { zap, anchor } of replyables) {
      const zapId = zap.event?.id;
      const count = zapId ? (counts.get(zapId) ?? 0) : 0;
      if (count <= 0 || !zapId) continue;

      const threadBadge = document.createElement('div');
      threadBadge.className = 'zaps-list__badge zaps-list__badge--thread';
      threadBadge.textContent = `T${count}`;
      Tooltip.attach(threadBadge, 'See zap comment thread');
      threadBadge.addEventListener('click', e => {
        e.stopPropagation();
        userHoverCard.hide();
        // Prime the cache so the zap-rooted SNV resolves instantly — zap
        // receipts are often unfetchable by id from relays alone.
        if (zap.event) this.postsApi?.registerNote(zap.event);
        // No click event passed on purpose: in right-pane this opens the zap
        // thread as a NEW tab so the original note tab stays reachable.
        getViewNavigationController().openView('single-note', zapId);
      });

      anchor.insertAdjacentElement('afterend', threadBadge);
    }
  }

  /**
   * Reply to a zap (NIP-22 comment on the kind:9735) — existing ReplyModal
   * flow, now behind the pill pulldown.
   */
  private async replyToZap(zap: ZapData): Promise<void> {
    const receiptEvent = zap.event;
    if (!receiptEvent?.id) return;
    const { ReplyModal } = await import('../reply/ReplyModal');
    await ReplyModal.getInstance().show(receiptEvent.id, receiptEvent);
  }

  /**
   * React to a zap (kind:7 → kind:9735) via the shared EmojiPicker — same
   * flow as reactToReaction (NIP-30 custom emojis included). The reaction's
   * p-tag points at the zap sender; anonymous receipts fall back to the
   * receipt's p-tag (recipient), since no real sender identity exists.
   */
  private async reactToZap(
    zap: ZapData,
    triggerEl: HTMLElement
  ): Promise<void> {
    const receipt = zap.event;
    if (!receipt?.id) return;
    if (!AuthGuard.requireAuth('react to zap')) return;

    // Load the user's NIP-30 custom emoji pack when the addon is on, so the
    // picker shows the same Custom tab as the direct like flow (LikeManager).
    let customEmojis: CustomEmojiEntry[] | undefined;
    if (isCustomEmojisEnabled()) {
      try {
        const { EmojiService } = await import(
          '../../addons/custom-emojis/EmojiService'
        );
        const service = EmojiService.getInstance();
        void service.refreshFromRelays();
        customEmojis = service.getEmojis();
      } catch (err) {
        console.debug('[ZapsList] Custom emoji load failed:', err);
      }
    }

    const { EmojiPicker } = await import('../emoji/EmojiPicker');
    const picker = new EmojiPicker({
      triggerElement: triggerEl,
      ...(customEmojis ? { customEmojis } : {}),
      onSelect: async emoji => {
        picker.destroy();
        await this.publishZapReaction(zap, emoji);
      },
      onCustomSelect: async entry => {
        picker.destroy();
        await this.publishZapReaction(zap, `:${entry.shortcode}:`, [
          'emoji',
          entry.shortcode,
          entry.url,
        ]);
      },
    });
    picker.show();
  }

  private async publishZapReaction(
    zap: ZapData,
    emoji: string,
    emojiTag?: [string, string, string]
  ): Promise<void> {
    const receipt = zap.event;
    if (!receipt?.id) return;
    const senderPubkey = zap.isAnonymous
      ? receipt.tags.find(t => t[0] === 'p')?.[1] || zap.zapperPubkey
      : zap.zapperPubkey;
    await this.reactionsApi?.publishReaction({
      noteId: receipt.id,
      authorPubkey: senderPubkey,
      emoji,
      ...(emojiTag ? { emojiTag } : {}),
      targetEvent: receipt,
    });
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.detachBus();
    this.dropdowns.forEach(dd => dd.destroy());
    this.dropdowns = [];
    this.element.remove();
  }
}
