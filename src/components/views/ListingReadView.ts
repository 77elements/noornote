/**
 * ListingReadView — Core read-only detail view for NIP-99 classified listings
 * (kind 30402), mounted on /listing/:naddr when the marketplace addon is OFF.
 *
 * Listings must stay readable everywhere (reposts, notifications and bookmarks
 * link here regardless of addon state). With the addon ON, the richer addon
 * ListingView (image carousel, contact/bookmark actions, reviews) takes over —
 * see ViewMountingService case 'listing'.
 *
 * Structure mirrors ZapstoreAppView: metadata card + ISL + RepliesRenderer
 * (kind 1111 comments), so a listing reads like any other supported kind.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { View } from './View';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import { InteractionStatusLine } from '../ui/InteractionStatusLine';
import { RepliesRenderer } from '../replies/RepliesRenderer';
import { getAddressableIdentifier } from '../../helpers/getAddressableIdentifier';
import {
  parseListingMetadata,
  formatPrice,
} from '../../helpers/listingMetadata';
import { UserProfileService } from '../../services/UserProfileService';
import { ContentProcessor } from '../../services/ContentProcessor';
import { AuthService } from '../../services/AuthService';
import { hexToNpub } from '../../helpers/nip19';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';

export class ListingReadView extends View {
  private container: HTMLElement;
  private naddr: string;

  constructor(naddr: string) {
    super();
    this.naddr = naddr;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--listing-read';
    void this.render();
  }

  private async render(): Promise<void> {
    this.container.innerHTML = `
      <div class="listing-read__loading">
        <p class="pulsate">Loading listing…</p>
      </div>
    `;

    try {
      const articlesApi =
        ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
      const event =
        (await articlesApi?.fetchAddressableEvent(this.naddr)) ?? null;

      if (!event) {
        this.container.innerHTML =
          '<div class="listing-read__error"><p>Listing not found</p></div>';
        return;
      }

      this.renderListing(event);
    } catch {
      this.container.innerHTML =
        '<div class="listing-read__error"><p>Failed to load listing</p></div>';
    }
  }

  private renderListing(event: NostrEvent): void {
    const meta = parseListingMetadata(event);
    const priceDisplay = formatPrice(
      meta.price,
      meta.priceCurrency,
      meta.priceFrequency
    );
    const npub = hexToNpub(event.pubkey) || event.pubkey;

    // Description: same markdown pipeline as the addon detail view
    const renderedDescription = event.content
      ? ContentProcessor.getInstance().processContent(event.content).html
      : '';

    // Images: standard note-media grid with clickable images (global
    // ImageClickHandler opens the lightbox — inviolable media-click rule)
    const gridImages = meta.images.slice(0, 4);
    const gridModifier =
      gridImages.length === 1
        ? ''
        : gridImages.length === 3
          ? ' note-media--grid-3'
          : ' note-media--grid-2';
    const imagesHtml =
      gridImages.length > 0
        ? `<div class="note-media${gridModifier}">${gridImages
            .map(
              url => `
          <div class="note-media__cell">
            <img class="note-image note-image--clickable" src="${escapeHtmlAttr(url)}" alt="" loading="lazy" />
          </div>
        `
            )
            .join('')}</div>`
        : '';

    this.container.innerHTML = `
      <article class="listing-read">
        ${imagesHtml}

        <header class="listing-read__header">
          <h1 class="listing-read__title">${escapeHtml(meta.title)}</h1>
          <div class="listing-read__price">${escapeHtml(priceDisplay)}</div>
          ${meta.status === 'sold' ? '<span class="badge badge--danger">Sold</span>' : ''}
          ${
            meta.location
              ? `
            <div class="listing-read__location">
              <svg width="16" height="16"><use href="#icon-location"/></svg>
              ${escapeHtml(meta.location)}
            </div>
          `
              : ''
          }
        </header>

        <div class="listing-read__seller user-mention" data-pubkey="${event.pubkey}">
          <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${event.pubkey}">Loading...</a>
          <span class="listing-read__date">${formatTimestamp(meta.publishedAt)}</span>
        </div>

        ${
          renderedDescription
            ? `
          <div class="listing-read__description">${renderedDescription}</div>
        `
            : ''
        }

        ${
          meta.tags.length > 0
            ? `
          <div class="listing-read__tags">
            ${meta.tags.map(tag => `<span class="hashtag">#${escapeHtml(tag)}</span>`).join(' ')}
          </div>
        `
            : ''
        }

        <div class="listing-read__isl" data-listing-isl></div>
        <div class="listing-read__replies" data-listing-replies></div>
      </article>
    `;

    this.loadSellerProfile(event.pubkey);
    this.mountIsl(event);
    this.mountReplies(event);
  }

  private mountIsl(event: NostrEvent): void {
    const mount = this.container.querySelector('[data-listing-isl]');
    if (!mount || !event.id) return;

    const addressableId = getAddressableIdentifier(event);
    const noteId = addressableId || event.id;
    const isLoggedIn = !!AuthService.getInstance().getCurrentUser();
    const isl = new InteractionStatusLine({
      noteId,
      authorPubkey: event.pubkey,
      originalEvent: event,
      fetchStats: true,
      isLoggedIn,
      articleEventId: event.id,
    });
    mount.appendChild(isl.getElement());
  }

  private mountReplies(event: NostrEvent): void {
    const container = this.container.querySelector(
      '[data-listing-replies]'
    ) as HTMLElement | null;
    if (!container || !event.id) return;

    const addressableId = getAddressableIdentifier(event);
    const noteId = addressableId || event.id;
    const repliesRenderer = new RepliesRenderer({
      container,
      noteId,
      noteAuthor: event.pubkey,
    });
    void repliesRenderer.loadAndRender();
  }

  private async loadSellerProfile(pubkey: string): Promise<void> {
    const sellerEl = this.container.querySelector('.listing-read__seller');
    if (!sellerEl) return;

    const npub = hexToNpub(pubkey) || pubkey;
    try {
      const profile =
        await UserProfileService.getInstance().getUserProfile(pubkey);
      const username =
        profile?.name || profile?.display_name || `${npub.slice(0, 12)}...`;
      const link = sellerEl.querySelector('a');
      if (link) link.textContent = username;
    } catch {
      const link = sellerEl.querySelector('a');
      if (link) link.textContent = `${npub.slice(0, 12)}...`;
    }

    setupUserMentionHandlers(this.container);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }
}
