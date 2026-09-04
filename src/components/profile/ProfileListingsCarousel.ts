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

import { ModuleLoader } from '../../core/ModuleLoader';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import {
  createCardGrid,
  type ScrollCarouselInstance,
} from '../../helpers/CarouselHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { dedupeByCoordinateWithTombstones } from '../../helpers/addressableDedupe';
import {
  parseListingMetadata,
  formatPrice,
  type ListingMetadata,
} from '../../addons/marketplace/marketplace-helpers';

interface ListingCardData {
  event: NostrEvent;
  metadata: ListingMetadata;
  naddr: string;
}

export class ProfileListingsCarousel {
  private element: HTMLElement;
  private pubkey: string;
  private listings: ListingCardData[] = [];
  private _profileApi: ProfileModuleApi | null = null;
  private profileApiPromise: Promise<ProfileModuleApi> | null = null;

  /** Boot-race safe: loads the profile module on demand. */
  private ensureProfileApi(): Promise<ProfileModuleApi> {
    this.profileApiPromise ??= (async () => {
      this._profileApi ??=
        ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile');
      if (!this._profileApi) {
        const api =
          await ModuleLoader.getInstance().ensure<ProfileModuleApi>('profile');
        if (!api) {
          throw new Error('Profile module failed to load');
        }
        this._profileApi = api;
      }
      return this._profileApi;
    })();
    return this.profileApiPromise;
  }

  private carousel: ScrollCarouselInstance | null = null;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
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
    try {
      // Shared fetch (read + outbound relays) via the profile module,
      // reusing the same cached round-trip as the articles/videos carousels.
      // It also returns this author's kind:5 deletions for the tombstone filter.
      const profileApi = await this.ensureProfileApi();
      const content = await profileApi.fetchCarouselContent(this.pubkey);
      const rawEvents = content.listings;
      const deletionEvents = content.deletions;
      const hintRelays = content.hintRelays;

      // Index NIP-09 deletions, dedupe by coordinate, apply tombstone
      // filter — shared with the articles carousel (see helper).
      const events = dedupeByCoordinateWithTombstones(
        rawEvents,
        deletionEvents,
        [`30402:${this.pubkey}:`]
      );

      // Newest first by created_at
      events.sort((a, b) => b.created_at - a.created_at);

      this.listings = events.map(event => {
        const metadata = parseListingMetadata(event);
        const naddr = encodeNaddr({
          kind: 30402,
          pubkey: event.pubkey,
          identifier: metadata.identifier,
          relays: hintRelays,
        });
        return { event, metadata, naddr };
      });

      const { diagLog } = await import('../../services/DiagnosticLogger');
      diagLog('system', 'ListingsCarousel: loaded', {
        count: this.listings.length,
      });
    } catch (error) {
      console.error(
        '[ProfileListingsCarousel] Failed to fetch listings:',
        error
      );
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

      const priceLine = formatPrice(
        metadata.price,
        metadata.priceCurrency,
        metadata.priceFrequency
      );

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

    this.carousel = createCardGrid({
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
