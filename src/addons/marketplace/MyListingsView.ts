/**
 * MyListingsView - Seller's Dashboard
 * Shows all listings owned by the current user with Edit and Delete actions.
 */

import { View } from '../../components/views/View';
import { Router } from '../../services/Router';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { AuthService } from '../../services/AuthService';
import { AuthGuard } from '../../services/AuthGuard';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { SystemLogger } from '../../services/SystemLogger';
import { ToastService } from '../../services/ToastService';
import { parseListingMetadata, formatPrice } from './marketplace-helpers';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { getTag } from '../../helpers/tagUtils';

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
    void this.loadListings();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="marketplace-timeline">
        <div class="marketplace-timeline__sticky-header">
          <header class="marketplace-view__header">
            <div class="marketplace-view__header-row">
              <h1 class="marketplace-view__title">My Listings</h1>
              <div class="marketplace-view__header-actions">
                <button class="btn btn--medium btn--passive" data-action="back-to-marketplace">← Back to Marketplace</button>
                <button class="btn btn--medium" data-action="add-product">Add Product</button>
              </div>
            </div>
          </header>
        </div>
        <div class="my-listings__list pulsate">Loading your listings...</div>
      </div>
    `;

    // Wire up header buttons
    this.container
      .querySelector('[data-action="back-to-marketplace"]')
      ?.addEventListener('click', () => {
        this.router.navigate('/marketplace');
      });
    this.container
      .querySelector('[data-action="add-product"]')
      ?.addEventListener('click', () => {
        this.router.navigate('/write-listing');
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

      const events = await transport.fetch(
        relays,
        [
          {
            kinds: [30402 as number],
            authors: [currentUser.pubkey],
          },
        ],
        10000,
        false,
        'MyListings'
      );

      // Deduplicate by d-tag (keep newest)
      const deduped = new Map<string, NostrEvent>();
      for (const event of events) {
        const dTag = getTag(event.tags, 'd');
        const key = `${event.pubkey}:${dTag}`;
        const existing = deduped.get(key);
        if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
          deduped.set(key, event);
        }
      }

      this.listings = Array.from(deduped.values()).sort(
        (a, b) => (b.created_at || 0) - (a.created_at || 0)
      );

      this.renderListings(listContainer as HTMLElement);
    } catch (error) {
      this.systemLogger.error(
        'MyListingsView',
        'Failed to load listings:',
        error
      );
      listContainer.innerHTML =
        '<div class="marketplace-timeline__error"><p>Failed to load listings</p></div>';
      listContainer.classList.remove('pulsate');
    }
  }

  private renderListings(listContainer: HTMLElement): void {
    listContainer.classList.remove('pulsate');

    if (this.listings.length === 0) {
      listContainer.innerHTML = `
        <div class="marketplace-timeline__empty">
          <svg width="48" height="48"><use href="#icon-shopping-bag"/></svg>
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
      relays: [],
    });

    const priceDisplay = formatPrice(
      meta.price,
      meta.priceCurrency,
      meta.priceFrequency
    );
    const firstImage = meta.images[0] || '';

    const row = document.createElement('div');
    row.className = 'post-item my-listings__row';
    row.dataset.identifier = meta.identifier;

    const statusClass =
      meta.status === 'sold'
        ? 'listing-card__sold-badge'
        : meta.status === 'inactive'
          ? 'listing-card__sold-badge my-listings__badge--inactive'
          : 'listing-card__sold-badge my-listings__badge--active';

    row.innerHTML = `
      <div class="my-listings__row-content">
        ${
          firstImage
            ? `<img class="my-listings__thumb" src="${escapeHtmlAttr(firstImage)}" alt="" />`
            : `
          <div class="my-listings__thumb my-listings__thumb--empty">
            <svg width="20" height="20"><use href="#icon-image"/></svg>
          </div>
        `
        }
        <div class="my-listings__info">
          <span class="my-listings__title">${escapeHtml(meta.title)}</span>
          <span class="my-listings__price">${escapeHtml(priceDisplay)}</span>
          <span class="${statusClass}">${meta.status.charAt(0).toUpperCase() + meta.status.slice(1)}</span>
        </div>
      </div>
      <div class="my-listings__actions">
        <button class="btn-icon" data-action="edit" title="Edit listing">
          <svg width="16" height="16"><use href="#icon-edit"/></svg>
        </button>
        <button class="btn-icon" data-action="delete" title="Delete listing">
          <svg width="16" height="16"><use href="#icon-delete"/></svg>
        </button>
      </div>
    `;

    // Click on row content → view listing (right-pane opens it in the scc)
    row
      .querySelector('.my-listings__row-content')
      ?.addEventListener('click', e => {
        getViewNavigationController().openView(
          'listing',
          naddr,
          e as MouseEvent
        );
      });

    // Edit
    row.querySelector('[data-action="edit"]')?.addEventListener('click', e => {
      e.stopPropagation();
      this.router.navigate(`/write-listing/${naddr}`);
    });

    // Delete
    row
      .querySelector('[data-action="delete"]')
      ?.addEventListener('click', e => {
        e.stopPropagation();
        void this.confirmDelete(event, meta.identifier, row);
      });

    return row;
  }

  private async confirmDelete(
    event: NostrEvent,
    identifier: string,
    rowEl: HTMLElement
  ): Promise<void> {
    const { ModalService } = await import('../../services/ModalService');

    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete Listing',
      message:
        'This will send a deletion request to relays. Deletion is not guaranteed — relays may choose to ignore deletion requests.',
      confirmText: 'Delete',
      confirmDestructive: true,
      cancelText: 'Cancel',
    });

    if (!confirmed) return;

    try {
      const coordinate = `30402:${event.pubkey}:${identifier}`;
      const success = await (ModuleLoader.getInstance()
        .getApi<PostsModuleApi>('posts')
        ?.deleteByCoordinates([coordinate], 'listing removed') ??
        Promise.resolve(false));

      if (success) {
        rowEl.remove();
        ToastService.show('Listing deletion requested', 'success');

        // If no more listings, show empty state
        const listContainer =
          this.container.querySelector('.my-listings__list');
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
