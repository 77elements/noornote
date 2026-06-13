/**
 * ProfileListingsCarousel Component
 * Displays a user's NIP-99 classified listings (kind:30402) in a
 * horizontal carousel on the ProfileView. NIP-99 events are public,
 * so this works for any pubkey regardless of which client they use.
 *
 * Mount-gating happens at the ProfileView level via the viewer-local
 * `isProfileListingsEnabled()` preference. Empty result (no listings)
 * collapses the element via `display:none`.
 *
 * @component ProfileListingsCarousel
 * @used-by ProfileView
 */

import { NostrTransport } from '../../services/transport/NostrTransport';
import { ProfileCarouselOrchestrator } from '../../services/orchestration/ProfileCarouselOrchestrator';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { createScrollCarousel, type ScrollCarouselInstance } from '../../helpers/CarouselHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { parseListingMetadata, formatPrice, type ListingMetadata } from '../../addons/marketplace/marketplace-helpers';

interface ListingCardData {
  event: NostrEvent;
  metadata: ListingMetadata;
  naddr: string;
}

export class ProfileListingsCarousel {
  private element: HTMLElement;
  private pubkey: string;
  private listings: ListingCardData[] = [];
  private transport: NostrTransport;
  private carousel: ScrollCarouselInstance | null = null;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
    this.transport = NostrTransport.getInstance();
    this.element = document.createElement('div');
    this.element.className = 'profile-listings-carousel';
  }

  public async render(): Promise<HTMLElement> {
    await this.fetchListings();

    if (this.listings.length === 0) {
      this.element.style.display = 'none';
      return this.element;
    }

    this.renderCarousel();
    return this.element;
  }

  private async fetchListings(): Promise<void> {
    const relays = this.transport.getReadRelays();

    try {
      // Shared fetch (read + outbound relays) via the carousel orchestrator,
      // reusing the same cached round-trip as the articles/videos carousels.
      // It also returns this author's kind:5 deletions for the tombstone filter.
      const content = await ProfileCarouselOrchestrator.getInstance().fetchProfileContent(this.pubkey);
      const rawEvents = content.listings;
      const deletionEvents = content.deletions;

      const deletedCoordinates = new Map<string, number>();
      const prefix = `30402:${this.pubkey}:`;
      for (const delEvent of deletionEvents) {
        for (const tag of delEvent.tags) {
          if (tag[0] !== 'a' || !tag[1] || !tag[1].startsWith(prefix)) continue;
          const coord = tag[1];
          const existing = deletedCoordinates.get(coord);
          if (!existing || delEvent.created_at > existing) {
            deletedCoordinates.set(coord, delEvent.created_at);
          }
        }
      }

      // Dedupe by addressable coordinate `30402:<pubkey>:<d>`, keep latest
      // created_at per coord, then drop coords whose deletion is newer
      // than the surviving event.
      const eventsByCoord = new Map<string, NostrEvent>();
      for (const event of rawEvents) {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
        const coord = `${event.kind}:${event.pubkey}:${dTag}`;
        const existing = eventsByCoord.get(coord);
        if (!existing || event.created_at > existing.created_at) {
          eventsByCoord.set(coord, event);
        }
      }
      const events = Array.from(eventsByCoord.entries())
        .filter(([coord, event]) => {
          const delTs = deletedCoordinates.get(coord);
          return delTs === undefined || event.created_at > delTs;
        })
        .map(([, event]) => event);

      // Newest first by created_at
      events.sort((a, b) => b.created_at - a.created_at);

      this.listings = events.map(event => {
        const metadata = parseListingMetadata(event);
        const naddr = encodeNaddr({
          kind: 30402,
          pubkey: event.pubkey,
          identifier: metadata.identifier,
          relays: relays.slice(0, 2),
        });
        return { event, metadata, naddr };
      });

      const { diagLog } = await import('../../services/DiagnosticLogger');
      diagLog('system', 'ListingsCarousel: loaded', {
        count: this.listings.length,
      });
    } catch (error) {
      console.error('[ProfileListingsCarousel] Failed to fetch listings:', error);
      this.listings = [];
    }
  }

  private renderCarousel(): void {
    const cards = this.listings.map(listing => {
      const { metadata, naddr } = listing;
      const firstImage = metadata.images[0] || '';

      const mediaHtml = firstImage
        ? `<div class="nn-card__media"><img src="${escapeHtmlAttr(firstImage)}" alt="" loading="lazy" /></div>`
        : `<div class="nn-card__media nn-card__media--empty"></div>`;

      const priceLine = formatPrice(metadata.price, metadata.priceCurrency, metadata.priceFrequency);

      return {
        html: `
          ${mediaHtml}
          <div class="nn-card__content">
            <h3>${escapeHtml(metadata.title)}</h3>
            <div class="meta">
              <span>${escapeHtml(priceLine)}</span>
            </div>
          </div>
        `,
        data: { naddr },
      };
    });

    this.carousel = createScrollCarousel({
      title: 'Products',
      cards,
      onCardClick: (_index, data) => {
        if (!data.naddr) return;
        // Right-pane mode opens the listing in the secondary pane (scc).
        getViewNavigationController().openView('listing', data.naddr);
      },
    });

    this.element.appendChild(this.carousel.element);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.carousel) this.carousel.destroy();
    this.element.remove();
  }
}
