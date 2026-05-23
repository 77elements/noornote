/**
 * MarketplaceTimelineInjector
 *
 * Periodically injects listing cards from followed users into the main timeline.
 * Timer pauses when timeline is not visible, resumes when it comes back.
 * Round-robin queue ensures all listings get shown before repeating.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { FREQUENCY_INTERVALS, getTimelineListingFrequency } from './index';
import { parseListingMetadata, formatPrice } from './marketplace-helpers';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { UserService } from '../../services/UserService';
import { AuthService } from '../../services/AuthService';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { hexToNpub } from '../../helpers/nip19';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { getTag } from '../../helpers/tagUtils';

export class MarketplaceTimelineInjector {
  private static instance: MarketplaceTimelineInjector;

  private queue: NostrEvent[] = [];
  private queueIndex = 0;
  private timerId: number | null = null;
  private listingsLoaded = false;
  private injectCallback: ((element: HTMLElement) => void) | null = null;

  private constructor() {}

  public static getInstance(): MarketplaceTimelineInjector {
    if (!MarketplaceTimelineInjector.instance) {
      MarketplaceTimelineInjector.instance = new MarketplaceTimelineInjector();
    }
    return MarketplaceTimelineInjector.instance;
  }

  /**
   * Start the injection timer.
   * @param onInject — called with the listing card element to prepend into the timeline
   */
  public async start(onInject: (element: HTMLElement) => void): Promise<void> {
    this.pause(); // Stop any existing timer
    this.injectCallback = onInject;

    if (!this.listingsLoaded) {
      await this.loadListings();
    }

    if (this.queue.length === 0) return;

    this.scheduleNext();
  }

  /** Pause timer (timeline hidden) */
  public pause(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /** Resume timer (timeline visible again) */
  public resume(): void {
    if (!this.injectCallback || this.queue.length === 0) return;
    if (this.timerId !== null) return; // already running
    this.scheduleNext();
  }

  /** Full cleanup */
  public destroy(): void {
    this.pause();
    this.injectCallback = null;
    this.queue = [];
    this.queueIndex = 0;
    this.listingsLoaded = false;
  }

  private getIntervalMs(): number {
    return FREQUENCY_INTERVALS[getTimelineListingFrequency()] || FREQUENCY_INTERVALS.rare;
  }

  private scheduleNext(): void {
    if (this.timerId !== null) return;
    this.timerId = window.setTimeout(() => {
      this.timerId = null;
      this.injectNext();
      // Schedule again for next listing
      if (this.queue.length > 0 && this.injectCallback) {
        this.scheduleNext();
      }
    }, this.getIntervalMs());
  }

  private injectNext(): void {
    if (this.queue.length === 0 || !this.injectCallback) return;

    // Wrap around when all listings have been shown
    if (this.queueIndex >= this.queue.length) {
      this.shuffleQueue();
      this.queueIndex = 0;
    }

    const event = this.queue[this.queueIndex]!;
    this.queueIndex++;

    const card = this.createTimelineListingCard(event);
    this.injectCallback(card);
  }

  private async loadListings(): Promise<void> {
    try {
      const authService = AuthService.getInstance();
      const currentUser = authService.getCurrentUser();
      if (!currentUser) return;

      const userService = UserService.getInstance();
      const follows = await userService.getUserFollowing(currentUser.pubkey);
      if (follows.length === 0) return;

      const transport = NostrTransport.getInstance();
      const relays = RelayConfig.getInstance().getReadRelays();
      if (relays.length === 0) return;

      const events = await transport.fetch(relays, [{
        kinds: [30402 as number],
        authors: follows,
        limit: 200
      }], 10000, false, 'MarketplaceInjector');

      // Deduplicate by pubkey:d-tag, keep newest
      const deduped = new Map<string, NostrEvent>();
      for (const event of events) {
        const dTag = getTag(event.tags, 'd');
        const key = `${event.pubkey}:${dTag}`;
        const existing = deduped.get(key);
        if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
          deduped.set(key, event);
        }
      }

      // Filter: must have title, image, not NSFW, status active
      this.queue = Array.from(deduped.values()).filter(event => {
        const meta = parseListingMetadata(event);
        if (!meta.title || meta.title === 'Untitled Listing') return false;
        if (meta.images.length === 0) return false;
        if (meta.status === 'sold') return false;
        return true;
      });

      this.shuffleQueue();
      this.queueIndex = 0;
      this.listingsLoaded = true;
    } catch (error) {
      console.error('[MarketplaceTimelineInjector] Failed to load listings:', error);
    }
  }

  private shuffleQueue(): void {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
    }
  }

  private createTimelineListingCard(event: NostrEvent): HTMLElement {
    const meta = parseListingMetadata(event);
    const naddr = encodeNaddr({
      kind: 30402,
      pubkey: event.pubkey,
      identifier: meta.identifier,
      relays: []
    });

    const priceDisplay = formatPrice(meta.price, meta.priceCurrency, meta.priceFrequency);
    const firstImage = meta.images[0] || '';

    const card = document.createElement('div');
    card.className = 'timeline-listing-card';

    card.innerHTML = `
      ${firstImage ? `
        <div class="timeline-listing-card__image">
          <img src="${escapeHtmlAttr(firstImage)}" alt="" loading="lazy" />
        </div>
      ` : ''}
      <div class="timeline-listing-card__body">
        <div class="timeline-listing-card__seller" data-pubkey="${event.pubkey}">
          <a href="#" class="mention-link" data-profile-pubkey="${event.pubkey}">Loading...</a>
          <span class="timeline-listing-card__badge">Marketplace</span>
        </div>
        <h3 class="timeline-listing-card__title">${escapeHtml(meta.title)}</h3>
        <div class="timeline-listing-card__price">${escapeHtml(priceDisplay)}</div>
        ${meta.summary ? `<p class="timeline-listing-card__summary">${escapeHtml(meta.summary.slice(0, 120))}${meta.summary.length > 120 ? '...' : ''}</p>` : ''}
        <div class="timeline-listing-card__actions">
          <button class="btn-icon" data-listing-action="repost" title="Repost">
            <svg width="16" height="16"><use href="#icon-repost"/></svg>
          </button>
          <button class="btn-icon" data-listing-action="quote" title="Quote">
            <span style="font-size:1.3rem;line-height:1">❝</span>
          </button>
        </div>
      </div>
    `;

    // Hide card if image fails to load
    const img = card.querySelector('img');
    if (img) {
      img.addEventListener('error', () => card.remove());
    }

    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Repost/Quote buttons — stop propagation, handle async
      const actionBtn = target.closest('[data-listing-action]') as HTMLElement | null;
      if (actionBtn) {
        e.stopPropagation();
        void this.handleListingAction(actionBtn.dataset.listingAction!, event);
        return;
      }

      // Seller profile link
      if (target.closest('.mention-link')) {
        e.preventDefault();
        const pubkey = target.closest('[data-profile-pubkey]')?.getAttribute('data-profile-pubkey');
        if (pubkey) {
          const npub = hexToNpub(pubkey);
          if (npub) Router.getInstance().navigate(`/profile/${npub}`);
        }
        return;
      }
      Router.getInstance().navigate(`/listing/${naddr}`);
    });

    this.loadSellerName(card, event.pubkey);

    return card;
  }

  private async handleListingAction(action: string, event: NostrEvent): Promise<void> {
    const { AuthGuard } = await import('../../services/AuthGuard');
    if (!AuthGuard.requireAuth('share this listing')) return;

    if (action === 'repost') {
      const { RepostService } = await import('../../services/RepostService');
      await RepostService.getInstance().publishGenericRepost({
        originalEvent: event,
      });
    } else if (action === 'quote') {
      const dTag = getTag(event.tags, 'd');
      const writeRelays = await RelayConfig.getInstance().getWriteRelays();
      const reference = 'nostr:' + encodeNaddr({
        kind: 30402,
        pubkey: event.pubkey,
        identifier: dTag,
        relays: writeRelays.slice(0, 2),
      });
      const { PostNoteModal } = await import('../../components/post/PostNoteModal');
      PostNoteModal.getInstance().show(reference);
    }
  }

  private async loadSellerName(card: HTMLElement, pubkey: string): Promise<void> {
    const linkEl = card.querySelector('.mention-link');
    if (!linkEl) return;

    const npub = hexToNpub(pubkey) || pubkey;

    try {
      const profile = await UserProfileService.getInstance().getUserProfile(pubkey);
      const displayName = profile?.name || profile?.display_name || npub.slice(0, 12) + '...';
      linkEl.textContent = displayName;
    } catch {
      linkEl.textContent = npub.slice(0, 12) + '...';
    }
  }
}
