/**
 * Render simple quote preview for PostNoteModal
 * Single purpose: Fetch and render quoted note/article as truncated preview
 *
 * @param nostrRef - nostr:nevent or nostr:naddr reference
 * @returns Promise<HTMLElement> - Quote preview element
 */

import { decodeNip19 } from '../services/NostrToolsAdapter';
import { NostrTransport } from '../services/transport/NostrTransport';
import { UserProfileService } from '../services/UserProfileService';
import { escapeHtml, escapeHtmlAttr } from './escapeHtml';
import { getTag } from './tagUtils';

export async function renderQuotePreview(nostrRef: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'quote-preview';
  container.innerHTML = '<div class="quote-preview__loading">Loading quoted note...</div>';

  try {
    const cleanRef = nostrRef.replace(/^nostr:/, '');
    const decoded = decodeNip19(cleanRef);

    if (decoded.type === 'naddr') {
      return await renderNaddrPreview(container, decoded.data as NaddrData);
    }

    if (decoded.type === 'nevent') {
      return await renderNeventPreview(container, decoded.data as NeventData);
    }

    throw new Error(`Unsupported reference type: ${decoded.type}`);
  } catch (error) {
    console.debug('Failed to render quote preview:', error);
    container.innerHTML = '<div class="quote-preview__error">Failed to load quoted note</div>';
    return container;
  }
}

interface NeventData {
  id: string;
  author?: string;
  relays?: string[];
}

interface NaddrData {
  kind: number;
  pubkey: string;
  identifier: string;
  relays?: string[];
}

async function renderNeventPreview(container: HTMLElement, data: NeventData): Promise<HTMLElement> {
  const transport = NostrTransport.getInstance();
  const readRelays = transport.getReadRelays();
  const hintRelays = data.relays || [];
  const allRelays = [...new Set([...readRelays, ...hintRelays])];

  const events = await transport.fetch(allRelays, [{ ids: [data.id], limit: 1 }], 5000, false, 'renderQuotePreview');

  const event = events[0];
  if (!event) {
    container.innerHTML = '<div class="quote-preview__error">Quoted note not found</div>';
    return container;
  }

  const authorName = await getAuthorName(event.pubkey);
  const displayContent = truncateContent(event.content);

  container.innerHTML = `
    <div class="quote-preview__header">
      <span class="quote-preview__author">${escapeHtml(authorName)}</span>
    </div>
    <div class="quote-preview__content">${escapeHtml(displayContent)}</div>
  `;
  return container;
}

async function renderNaddrPreview(container: HTMLElement, data: NaddrData): Promise<HTMLElement> {
  const transport = NostrTransport.getInstance();
  const readRelays = transport.getReadRelays();
  const hintRelays = data.relays || [];
  const allRelays = [...new Set([...readRelays, ...hintRelays])];

  const events = await transport.fetch(
    allRelays,
    [{ kinds: [data.kind], authors: [data.pubkey], '#d': [data.identifier], limit: 1 }],
    5000,
    false,
    'renderQuotePreview'
  );

  const event = events[0];
  if (!event) {
    container.innerHTML = '<div class="quote-preview__error">Quoted note not found</div>';
    return container;
  }

  // Marketplace listings (Kind 30402) → compact listing card preview
  if (data.kind === 30402) {
    const { parseListingMetadata, formatPrice } = await import('../addons/marketplace/marketplace-helpers');
    const meta = parseListingMetadata(event);
    const priceDisplay = formatPrice(meta.price, meta.priceCurrency, meta.priceFrequency);
    const authorName = await getAuthorName(event.pubkey);
    const firstImage = meta.images[0] || '';

    container.className = 'timeline-listing-card timeline-listing-card--quoted';
    container.innerHTML = `
      ${firstImage ? `
        <div class="timeline-listing-card__image">
          <img src="${escapeHtmlAttr(firstImage)}" alt="" loading="lazy" />
        </div>
      ` : ''}
      <div class="timeline-listing-card__body">
        <div class="timeline-listing-card__seller">
          <span>${escapeHtml(authorName)}</span>
          <span class="timeline-listing-card__badge">Marketplace</span>
        </div>
        <h3 class="timeline-listing-card__title">${escapeHtml(meta.title)}</h3>
        <div class="timeline-listing-card__price">${escapeHtml(priceDisplay)}</div>
      </div>
    `;
    return container;
  }

  const authorName = await getAuthorName(event.pubkey);
  const title = event.tags.find(t => t[0] === 'title')?.[1]
    || event.tags.find(t => t[0] === 'name')?.[1]
    || '';
  const summary = getTag(event.tags, 'summary');
  const displayContent = title
    ? (summary ? `${title}\n${summary}` : title)
    : truncateContent(event.content);

  container.innerHTML = `
    <div class="quote-preview__header">
      <span class="quote-preview__author">${escapeHtml(authorName)}</span>
    </div>
    <div class="quote-preview__content">${escapeHtml(truncateContent(displayContent))}</div>
  `;
  return container;
}

async function getAuthorName(pubkey: string): Promise<string> {
  const profile = await UserProfileService.getInstance().getUserProfile(pubkey);
  return profile?.name || profile?.display_name || 'Anonymous';
}

function truncateContent(content: string): string {
  const lines = content.split('\n');
  const truncated = lines.slice(0, 3).join('\n');
  const isTruncated = lines.length > 3 || truncated.length > 200;
  return isTruncated ? truncated.slice(0, 200) + '...' : truncated;
}
