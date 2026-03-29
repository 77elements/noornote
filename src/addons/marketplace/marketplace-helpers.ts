/**
 * Marketplace Helpers
 * Parse NIP-99 listing metadata and format prices.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { getTag } from '../../helpers/tagUtils';

export interface ListingMetadata {
  title: string;
  summary: string;
  images: string[];
  price: string;
  priceCurrency: string;
  priceFrequency: string;
  location: string;
  status: string;
  identifier: string;
  publishedAt: number;
  tags: string[];
  geohash: string;
}

/** Tag names that may contain image URLs (non-standard clients use various names) */
const IMAGE_TAG_NAMES = ['image', 'thumb', 'thumbnail', 'featuredImageUrl', 'screenshotsUrls'];

/** Regex to find image URLs in content */
const IMAGE_URL_REGEX = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?/gi;

/**
 * Extract images from event tags and content.
 * Handles NIP-99 standard `image` tags and non-standard variants
 * used by other clients (DegMods, Shopstr variants, etc.)
 */
function extractImages(event: NostrEvent): string[] {
  const tags = event.tags;
  const images: string[] = [];
  const seen = new Set<string>();

  // 1. Standard and non-standard image tags
  for (const tag of tags) {
    if (tag[0] && IMAGE_TAG_NAMES.includes(tag[0]) && tag[1]) {
      const url = tag[1];
      // Some tags contain JSON — skip those
      if (url.startsWith('http') && !seen.has(url)) {
        seen.add(url);
        images.push(url);
      }
    }
  }

  // 2. Check `r` tags that look like image URLs
  for (const tag of tags) {
    if (tag[0] === 'r' && tag[1] && IMAGE_URL_REGEX.test(tag[1]) && !seen.has(tag[1])) {
      seen.add(tag[1]);
      images.push(tag[1]);
      IMAGE_URL_REGEX.lastIndex = 0;
    }
  }

  // 3. Fallback: extract image URLs from markdown content
  if (images.length === 0 && event.content) {
    const contentUrls = event.content.match(IMAGE_URL_REGEX) || [];
    for (const url of contentUrls) {
      if (!seen.has(url)) {
        seen.add(url);
        images.push(url);
      }
    }
  }

  return images;
}

/**
 * Extract NIP-99 listing metadata from a kind:30402 event.
 * Handles both standard NIP-99 tags and non-standard variants.
 */
export function parseListingMetadata(event: NostrEvent): ListingMetadata {
  const tags = event.tags;

  // Price: standard ["price", "50", "USD"] or separate ["currency", "USD"] tag
  const priceTag = tags.find(t => t[0] === 'price');
  const currencyTag = tags.find(t => t[0] === 'currency');

  return {
    title: getTag(tags, 'title', 'Untitled Listing'),
    summary: getTag(tags, 'summary'),
    images: extractImages(event),
    price: priceTag?.[1] || '',
    priceCurrency: priceTag?.[2] || currencyTag?.[1] || '',
    priceFrequency: priceTag?.[3] || '',
    location: getTag(tags, 'location'),
    status: getTag(tags, 'status', 'active'),
    identifier: getTag(tags, 'd'),
    publishedAt: parseInt(tags.find(t => t[0] === 'published_at')?.[1] || String(event.created_at || 0)),
    tags: tags.filter(t => t[0] === 't').map(t => t[1]).filter((v): v is string => !!v),
    geohash: getTag(tags, 'g'),
  };
}

/**
 * Format price for display
 * Examples: "50 USD", "0.005 BTC", "15 EUR/month"
 */
export function formatPrice(price: string, currency: string, frequency: string): string {
  if (!price) return 'Price not set';

  const currencyUpper = currency.toUpperCase();
  const formatted = currencyUpper ? `${price} ${currencyUpper}` : price;

  if (frequency) {
    return `${formatted}/${frequency}`;
  }

  return formatted;
}
