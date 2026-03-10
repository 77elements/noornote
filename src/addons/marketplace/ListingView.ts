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

      this.container.innerHTML = `
        <div class="listing-view">
          <button class="listing-view__back btn btn--passive" data-action="back">Back to Marketplace</button>

          <div class="listing-view__images"></div>

          <div class="listing-view__header">
            <h1 class="listing-view__title">${escapeHtml(meta.title)}</h1>
            <div class="listing-view__price">${escapeHtml(priceDisplay)}</div>
            ${meta.status === 'sold' ? '<span class="listing-view__sold-badge">Sold</span>' : ''}
          </div>

          ${meta.location ? `
            <div class="listing-view__location">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                <circle cx="12" cy="10" r="3"></circle>
              </svg>
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
      content: '',
      image: img,
      imageAlt: ''
    }));

    this.carousel = createCarousel(slides, {
      showNav: true,
      showDots: true,
      prevLabel: '‹',
      nextLabel: '›'
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
        <button class="btn btn--passive" data-action="back">Back to Marketplace</button>
      </div>
    `;
    const backBtn = this.container.querySelector('[data-action="back"]');
    backBtn?.addEventListener('click', () => Router.getInstance().navigate('/marketplace'));
  }

  private showError(): void {
    this.container.innerHTML = `
      <div class="listing-view__error">
        <p>Failed to load listing</p>
        <button class="btn btn--passive" data-action="back">Back to Marketplace</button>
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
