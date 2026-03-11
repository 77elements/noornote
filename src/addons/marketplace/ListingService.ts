/**
 * ListingService - NIP-99 Classified Listing Publishing Service
 * Handles creation and updating of Kind 30402 listings.
 *
 * Pattern: Follows ArticleService exactly.
 * - Create: new d-tag + publish
 * - Edit: same d-tag + publish (relay replaces automatically per NIP-01)
 */

import { AuthService } from '../../services/AuthService';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { SystemLogger } from '../../components/system/SystemLogger';
import { ErrorService } from '../../services/ErrorService';
import { ToastService } from '../../services/ToastService';
import { encodeNaddr } from '../../services/NostrToolsAdapter';

export interface ListingOptions {
  title: string;
  content: string;
  identifier: string;
  price: string;
  priceCurrency: string;
  relays: string[];
  summary?: string;
  images?: string[];
  priceFrequency?: string;
  location?: string;
  status?: string;
  topics?: string[];
  publishedAt?: number;
}

export class ListingService {
  private static instance: ListingService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): ListingService {
    if (!ListingService.instance) {
      ListingService.instance = new ListingService();
    }
    return ListingService.instance;
  }

  /**
   * Publish or update a listing (Kind 30402).
   * For edits: pass the same identifier (d-tag) — relay replaces automatically.
   * @returns naddr on success, null on failure
   */
  public async publishListing(options: ListingOptions): Promise<string | null> {
    const { title, content, identifier, price, priceCurrency, relays } = options;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('ListingService', 'Cannot publish: User not authenticated');
      return null;
    }

    if (!title?.trim()) {
      ToastService.show('Title is required', 'error');
      return null;
    }

    if (!price?.trim() || !priceCurrency?.trim()) {
      ToastService.show('Price and currency are required', 'error');
      return null;
    }

    if (!identifier?.trim()) {
      ToastService.show('Identifier is required', 'error');
      return null;
    }

    if (!relays?.length) {
      ToastService.show('Please select at least one relay', 'error');
      return null;
    }

    try {
      const now = Math.floor(Date.now() / 1000);

      const tags: string[][] = [
        ['d', identifier.trim()],
        ['title', title.trim()],
        ['published_at', String(options.publishedAt || now)],
        ['status', options.status || 'active']
      ];

      // Price tag: ["price", "50", "USD"] or ["price", "15", "EUR", "month"]
      const priceTag = ['price', price.trim(), priceCurrency.trim()];
      if (options.priceFrequency) {
        priceTag.push(options.priceFrequency);
      }
      tags.push(priceTag);

      if (options.summary?.trim()) {
        tags.push(['summary', options.summary.trim()]);
      }

      if (options.images) {
        for (const url of options.images) {
          if (url.trim()) tags.push(['image', url.trim()]);
        }
      }

      if (options.location?.trim()) {
        tags.push(['location', options.location.trim()]);
      }

      if (options.topics) {
        for (const topic of options.topics) {
          const trimmed = topic.trim();
          if (trimmed) tags.push(['t', trimmed.toLowerCase()]);
        }
      }

      const unsignedEvent = {
        kind: 30402,
        created_at: now,
        tags,
        content: content.trim(),
        pubkey: currentUser.pubkey
      };

      const signedEvent = await this.authService.signEvent(unsignedEvent);
      if (!signedEvent) {
        this.systemLogger.error('ListingService', 'Failed to sign listing event');
        return null;
      }

      await this.transport.publish(relays, signedEvent);

      this.systemLogger.info(
        'ListingService',
        `Listing published to ${relays.length} relay(s): ${signedEvent.id?.slice(0, 8)}...`
      );

      ToastService.show('Listing published successfully!', 'success');

      return encodeNaddr({
        kind: 30402,
        pubkey: currentUser.pubkey,
        identifier: identifier.trim(),
        relays: relays.slice(0, 2)
      });
    } catch (error) {
      ErrorService.handle(error, 'ListingService.publishListing', true, 'Failed to publish listing. Please try again.');
      return null;
    }
  }

  /**
   * Generate a unique identifier from title
   */
  public static generateIdentifier(title?: string): string {
    const timestamp = Date.now().toString(36);

    if (title?.trim()) {
      const slug = title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 80);
      return slug ? `${slug}-${timestamp}` : timestamp;
    }

    return timestamp;
  }
}
