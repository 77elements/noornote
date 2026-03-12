/**
 * MyListingsView - Seller's Dashboard
 * Shows all listings owned by the current user with Edit and Delete actions.
 */

import { View } from '../../components/views/View';
import { Router } from '../../services/Router';
import { AuthService } from '../../services/AuthService';
import { AuthGuard } from '../../services/AuthGuard';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { DeletionService } from '../../services/DeletionService';
import { SystemLogger } from '../../components/system/SystemLogger';
import { ToastService } from '../../services/ToastService';
import { parseListingMetadata, formatPrice } from './marketplace-helpers';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export class MyListingsView extends View {
  private container: HTMLElement;
  private router: Router;
  private systemLogger: SystemLogger;
  private listings: NostrEvent[] = [];

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--my-listings';
    this.router = Router.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    if (!AuthGuard.requireAuth('view your listings')) return;

    this.render();
    this.loadListings();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="marketplace-timeline">
        <div class="marketplace-timeline__sticky-header">
          <header class="marketplace-view__header">
            <div class="marketplace-view__header-row">
              <h1 class="marketplace-view__title">My Listings</h1>
              <div class="marketplace-view__header-actions">
                <a href="/marketplace" class="btn btn--passive btn--medium">Back to Marketplace</a>
                <a href="/write-listing" class="btn btn--medium">Add Product</a>
              </div>
            </div>
          </header>
        </div>
        <div class="my-listings__list pulsate">Loading your listings...</div>
      </div>
    `;

    // Wire up header buttons
    this.container.querySelectorAll('.marketplace-view__header-actions a').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.router.navigate((e.currentTarget as HTMLAnchorElement).getAttribute('href')!);
      });
    });
  }

  private async loadListings(): Promise<void> {
    const listContainer = this.container.querySelector('.my-listings__list');
    if (!listContainer) return;

    try {
      const currentUser = AuthService.getInstance().getCurrentUser();
      if (!currentUser) return;

      const transport = NostrTransport.getInstance();
      const relays = RelayConfig.getInstance().getReadRelays();

      const events = await transport.fetch(relays, [{
        kinds: [30402 as number],
        authors: [currentUser.pubkey]
      }], 10000);

      // Deduplicate by d-tag (keep newest)
      const deduped = new Map<string, NostrEvent>();
      for (const event of events) {
        const dTag = event.tags?.find(t => t[0] === 'd')?.[1] || '';
        const key = `${event.pubkey}:${dTag}`;
        const existing = deduped.get(key);
        if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
          deduped.set(key, event);
        }
      }

      this.listings = Array.from(deduped.values())
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

      this.renderListings(listContainer as HTMLElement);
    } catch (error) {
      this.systemLogger.error('MyListingsView', 'Failed to load listings:', error);
      listContainer.innerHTML = '<div class="marketplace-timeline__error"><p>Failed to load listings</p></div>';
      listContainer.classList.remove('pulsate');
    }
  }

  private renderListings(listContainer: HTMLElement): void {
    listContainer.classList.remove('pulsate');

    if (this.listings.length === 0) {
      listContainer.innerHTML = `
        <div class="marketplace-timeline__empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
            <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <path d="M16 10a4 4 0 0 1-8 0"></path>
          </svg>
          <p>No listings yet</p>
          <span>Create your first product listing</span>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = '';
    for (const listing of this.listings) {
      listContainer.appendChild(this.createListingRow(listing));
    }
  }

  private createListingRow(event: NostrEvent): HTMLElement {
    const meta = parseListingMetadata(event);
    const naddr = encodeNaddr({
      kind: 30402,
      pubkey: event.pubkey,
      identifier: meta.identifier,
      relays: []
    });

    const priceDisplay = formatPrice(meta.price, meta.priceCurrency, meta.priceFrequency);
    const firstImage = meta.images[0] || '';

    const row = document.createElement('div');
    row.className = 'post-item my-listings__row';
    row.dataset.identifier = meta.identifier;

    const statusClass = meta.status === 'sold' ? 'listing-card__sold-badge'
      : meta.status === 'inactive' ? 'listing-card__sold-badge my-listings__badge--inactive'
      : 'listing-card__sold-badge my-listings__badge--active';

    row.innerHTML = `
      <div class="my-listings__row-content">
        ${firstImage ? `<img class="my-listings__thumb" src="${escapeHtmlAttr(firstImage)}" alt="" />` : `
          <div class="my-listings__thumb my-listings__thumb--empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
          </div>
        `}
        <div class="my-listings__info">
          <span class="my-listings__title">${escapeHtml(meta.title)}</span>
          <span class="my-listings__price">${escapeHtml(priceDisplay)}</span>
          <span class="${statusClass}">${meta.status.charAt(0).toUpperCase() + meta.status.slice(1)}</span>
        </div>
      </div>
      <div class="my-listings__actions">
        <button class="btn-icon" data-action="edit" title="Edit listing">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-icon" data-action="delete" title="Delete listing">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;

    // Click on row content → view listing
    row.querySelector('.my-listings__row-content')?.addEventListener('click', () => {
      this.router.navigate(`/listing/${naddr}`);
    });

    // Edit
    row.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.router.navigate(`/write-listing/${naddr}`);
    });

    // Delete
    row.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.confirmDelete(event, meta.identifier, row);
    });

    return row;
  }

  private async confirmDelete(event: NostrEvent, identifier: string, rowEl: HTMLElement): Promise<void> {
    const { ModalService } = await import('../../services/ModalService');

    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete Listing',
      message: 'This will send a deletion request to relays. Deletion is not guaranteed — relays may choose to ignore deletion requests.',
      confirmText: 'Delete',
      confirmDestructive: true,
      cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
      const coordinate = `30402:${event.pubkey}:${identifier}`;
      const success = await DeletionService.getInstance().deleteByCoordinates([coordinate], 'listing removed');

      if (success) {
        rowEl.remove();
        ToastService.show('Listing deletion requested', 'success');

        // If no more listings, show empty state
        const listContainer = this.container.querySelector('.my-listings__list');
        if (listContainer && listContainer.children.length === 0) {
          this.listings = [];
          this.renderListings(listContainer as HTMLElement);
        }
      } else {
        ToastService.show('Failed to delete listing', 'error');
      }
    } catch (error) {
      this.systemLogger.error('MyListingsView', 'Delete failed:', error);
      ToastService.show('Failed to delete listing', 'error');
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }
}
