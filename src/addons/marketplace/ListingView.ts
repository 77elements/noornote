/**
 * ListingView — Single listing detail view
 *
 * Part of the Marketplace Add-On — only loaded when feature is enabled.
 * Fetches a single kind:30402 event by naddr and renders it.
 */

import { View } from '../../components/views/View';
import { LongFormOrchestrator } from '../../services/orchestration/LongFormOrchestrator';
import { parseListingMetadata, formatPrice } from './marketplace-helpers';
import { UserProfileService } from '../../services/UserProfileService';
import { ContentProcessor } from '../../services/ContentProcessor';
import { Router } from '../../services/Router';
import { hexToNpub } from '../../helpers/nip19';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { createCarousel, type CarouselInstance } from '../../helpers/CarouselHelper';
import { AuthService } from '../../services/AuthService';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';
import { getTag } from '../../helpers/tagUtils';

const BOOKMARK_SVG_OUTLINE = `<svg class="listing-view__bookmark-icon" width="22" height="22"><use href="#icon-bookmark-24"/></svg>`;
const BOOKMARK_SVG_FILLED = `<svg class="listing-view__bookmark-icon listing-view__bookmark-icon--active" width="22" height="22"><use href="#icon-bookmark-24-filled"/></svg>`;

export class ListingView extends View {
  private container: HTMLElement;
  private naddr: string;
  private carousel: CarouselInstance | null = null;

  constructor(naddr: string) {
    super();
    this.naddr = naddr;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--listing';
    this.render();
  }

  private async render(): Promise<void> {
    this.container.innerHTML = `
      <div class="listing-view__loading">
        <div class="listing-view__loading-spinner"></div>
        <p>Loading listing...</p>
      </div>
    `;

    try {
      const orchestrator = LongFormOrchestrator.getInstance();
      const event = await orchestrator.fetchAddressableEvent(this.naddr);

      if (!event) {
        this.showNotFound();
        return;
      }

      const meta = parseListingMetadata(event);
      const priceDisplay = formatPrice(meta.price, meta.priceCurrency, meta.priceFrequency);
      const npub = hexToNpub(event.pubkey) || event.pubkey;

      // Render markdown content
      const contentProcessor = ContentProcessor.getInstance();
      const renderedContent = contentProcessor.processContent(event.content || '').html;

      // Build a-tag coordinate for bookmarking
      const dTag = getTag(event.tags, 'd');
      const aTagValue = `30402:${event.pubkey}:${dTag}`;
      const bookmarkDescription = `${meta.title}${priceDisplay ? ' — ' + priceDisplay : ''}`;

      // Check if already bookmarked (only if bookmarks addon enabled)
      const { isBookmarksEnabled } = await import('../bookmarks/index');
      let bookmarkedNow = false;
      if (isBookmarksEnabled()) {
        const { isNoteBookmarked } = await import('../../lists/bookmarks');
        const isBookmarked = isNoteBookmarked(aTagValue);
        bookmarkedNow = isBookmarked.public || isBookmarked.private;
      }

      this.container.innerHTML = `
        <div class="listing-view">
          <button class="listing-view__back btn btn--medium btn--passive" data-action="back">← Back to Marketplace</button>

          <div class="listing-view__images"></div>

          <div class="listing-view__header">
            <h1 class="listing-view__title">${escapeHtml(meta.title)}</h1>
            <div class="listing-view__price">${escapeHtml(priceDisplay)}</div>
            ${meta.status === 'sold' ? '<span class="listing-view__sold-badge">Sold</span>' : ''}
          </div>

          ${meta.location ? `
            <div class="listing-view__location">
              <svg width="16" height="16"><use href="#icon-location"/></svg>
              ${escapeHtml(meta.location)}
            </div>
          ` : ''}

          <div class="listing-view__seller">
            <span class="listing-view__seller-label">Seller</span>
            <span class="listing-view__seller-name user-mention" data-pubkey="${event.pubkey}">
              <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${event.pubkey}">Loading...</a>
            </span>
            <span class="listing-view__date">${formatTimestamp(meta.publishedAt)}</span>
          </div>

          <div class="listing-view__actions">
            <button class="btn btn--primary listing-view__contact-btn" data-pubkey="${event.pubkey}">Contact Seller</button>
            <button class="listing-view__bookmark-btn${bookmarkedNow ? ' listing-view__bookmark-btn--active' : ''}" data-a-tag="${escapeHtmlAttr(aTagValue)}" data-description="${escapeHtmlAttr(bookmarkDescription)}" aria-label="Bookmark listing" title="${bookmarkedNow ? 'Remove bookmark' : 'Bookmark listing'}" style="${isBookmarksEnabled() ? '' : 'display:none'}">
              ${bookmarkedNow ? BOOKMARK_SVG_FILLED : BOOKMARK_SVG_OUTLINE}
            </button>
          </div>

          ${event.content ? `
            <div class="listing-view__description">
              ${renderedContent}
            </div>
          ` : ''}

          ${meta.tags.length > 0 ? `
            <div class="listing-view__tags">
              ${meta.tags.map(tag => `<span class="listing-view__tag">#${escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      `;

      this.mountImageCarousel(meta.images);
      this.setupEventHandlers(event.pubkey);
      this.loadSellerProfile(event.pubkey);

    } catch {
      this.showError();
    }
  }

  private mountImageCarousel(images: string[]): void {
    const imagesContainer = this.container.querySelector('.listing-view__images');
    if (!imagesContainer || images.length === 0) {
      imagesContainer?.remove();
      return;
    }

    if (images.length === 1) {
      // Single image — no carousel needed
      imagesContainer.innerHTML = `
        <img class="listing-view__image" src="${escapeHtmlAttr(images[0]!)}" alt="" loading="lazy" />
      `;
      return;
    }

    // Multiple images — use carousel
    const slides = images.map(img => ({
      text: '',
      image: img,
      imageAlt: ''
    }));

    this.carousel = createCarousel(slides, {
      showNav: true,
      showDots: true
    });

    imagesContainer.classList.add('listing-view__images--carousel');
    imagesContainer.appendChild(this.carousel.element);
    this.carousel.init();
  }

  private setupEventHandlers(sellerPubkey: string): void {
    const router = Router.getInstance();

    const backBtn = this.container.querySelector('[data-action="back"]');
    backBtn?.addEventListener('click', () => router.navigate('/marketplace'));

    const contactBtn = this.container.querySelector('.listing-view__contact-btn');
    contactBtn?.addEventListener('click', () => {
      const npub = hexToNpub(sellerPubkey);
      if (npub) {
        router.navigate(`/messages/${npub}`);
      }
    });

    const bookmarkBtn = this.container.querySelector('.listing-view__bookmark-btn');
    bookmarkBtn?.addEventListener('click', async () => {
      await this.toggleBookmark(bookmarkBtn as HTMLElement);
    });
  }

  private async toggleBookmark(btn: HTMLElement): Promise<void> {
    const authService = AuthService.getInstance();
    const currentUser = authService.getCurrentUser();
    if (!currentUser) {
      ToastService.show('Log in to bookmark listings', 'info');
      return;
    }

    const aTagValue = btn.dataset.aTag!;
    const description = btn.dataset.description || '';
    const isActive = btn.classList.contains('listing-view__bookmark-btn--active');

    try {
      const { addBookmark, removeBookmark, isNoteBookmarked } = await import('../../lists/bookmarks');

      if (isActive) {
        await removeBookmark(aTagValue);
        btn.classList.remove('listing-view__bookmark-btn--active');
        btn.innerHTML = BOOKMARK_SVG_OUTLINE;
        btn.title = 'Bookmark listing';
        ToastService.show('Bookmark removed', 'success');
      } else {
        await addBookmark(aTagValue, false, '', 'a', description);
        btn.classList.add('listing-view__bookmark-btn--active');
        btn.innerHTML = BOOKMARK_SVG_FILLED;
        btn.title = 'Remove bookmark';
        ToastService.show('Listing bookmarked', 'success');
      }

      // Check actual state to be safe
      const status = isNoteBookmarked(aTagValue);
      const nowBookmarked = status.public || status.private;
      btn.classList.toggle('listing-view__bookmark-btn--active', nowBookmarked);
      btn.innerHTML = nowBookmarked ? BOOKMARK_SVG_FILLED : BOOKMARK_SVG_OUTLINE;

      EventBus.getInstance().emit('bookmark:updated', {});
    } catch {
      ToastService.show('Failed to update bookmark', 'error');
    }
  }

  private async loadSellerProfile(pubkey: string): Promise<void> {
    const sellerEl = this.container.querySelector('.listing-view__seller-name');
    if (!sellerEl) return;

    const npub = hexToNpub(pubkey) || pubkey;
    const userProfileService = UserProfileService.getInstance();

    try {
      const profile = await userProfileService.getUserProfile(pubkey);
      const username = profile?.name || profile?.display_name || npub.slice(0, 12) + '...';
      const picture = profile?.picture || '';

      sellerEl.innerHTML = `
        <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">
          <img class="profile-pic profile-pic--mini" src="${escapeHtmlAttr(picture)}" alt="" />${escapeHtml(username)}</a>
      `;
    } catch {
      sellerEl.innerHTML = `
        <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">
          ${npub.slice(0, 12)}...</a>
      `;
    }

    setupUserMentionHandlers(this.container);
  }

  private showNotFound(): void {
    this.container.innerHTML = `
      <div class="listing-view__not-found">
        <p>Listing not found</p>
        <button class="btn btn--medium btn--passive" data-action="back">← Back to Marketplace</button>
      </div>
    `;
    const backBtn = this.container.querySelector('[data-action="back"]');
    backBtn?.addEventListener('click', () => Router.getInstance().navigate('/marketplace'));
  }

  private showError(): void {
    this.container.innerHTML = `
      <div class="listing-view__error">
        <p>Failed to load listing</p>
        <button class="btn btn--medium btn--passive" data-action="back">← Back to Marketplace</button>
      </div>
    `;
    const backBtn = this.container.querySelector('[data-action="back"]');
    backBtn?.addEventListener('click', () => Router.getInstance().navigate('/marketplace'));
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.carousel) {
      this.carousel.destroy();
      this.carousel = null;
    }
    this.container.innerHTML = '';
  }
}
