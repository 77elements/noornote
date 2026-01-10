/**
 * Render simple quote preview for PostNoteModal
 * Single purpose: Fetch and render quoted note as 3-line truncated preview
 * NO dependency on QuotedNoteRenderer to avoid circular dependency
 *
 * @param nostrRef - nostr:nevent reference
 * @returns Promise<HTMLElement> - Quote preview element
 */

import { decodeNip19 } from '../services/NostrToolsAdapter';
import { NostrTransport } from '../services/transport/NostrTransport';
import { UserProfileService } from '../services/UserProfileService';
import { escapeHtml } from './escapeHtml';

export async function renderQuotePreview(nostrRef: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'quote-preview';
  container.innerHTML = '<div class="quote-preview__loading">Loading quoted note...</div>';

  try {
    // Extract event ID from nevent
    const cleanRef = nostrRef.replace(/^nostr:/, '');
    const decoded = decodeNip19(cleanRef);

    if (decoded.type !== 'nevent') {
      throw new Error('Invalid nevent reference');
    }

    const neventData = decoded.data as { id: string; author?: string; relays?: string[] };

    // Fetch event - use read relays AND nevent hints
    const transport = NostrTransport.getInstance();
    const readRelays = transport.getReadRelays();
    const neventRelays = neventData.relays || [];

    // Combine both relay sources (read relays first, then nevent hints)
    const allRelays = [...new Set([...readRelays, ...neventRelays])];

    const events = await transport.fetch(allRelays, [{ ids: [neventData.id], limit: 1 }], 5000);

    const event = events[0];
    if (!event) {
      container.innerHTML = '<div class="quote-preview__error">Quoted note not found</div>';
      return container;
    }

    // Fetch author profile
    const profileService = UserProfileService.getInstance();
    const profile = await profileService.getUserProfile(event.pubkey);
    const authorName = profile?.name || profile?.display_name || 'Anonymous';

    // Truncate content to 3 lines
    const content = event.content;
    const lines = content.split('\n');
    const truncated = lines.slice(0, 3).join('\n');
    const isTruncated = lines.length > 3 || truncated.length > 200;
    const displayContent = isTruncated ? truncated.slice(0, 200) + '...' : truncated;

    // Render quote preview
    container.innerHTML = `
      <div class="quote-preview__header">
        <span class="quote-preview__author">${escapeHtml(authorName)}</span>
      </div>
      <div class="quote-preview__content">${escapeHtml(displayContent)}</div>
    `;

    return container;
  } catch (error) {
    console.error('Failed to render quote preview:', error);
    container.innerHTML = '<div class="quote-preview__error">Failed to load quoted note</div>';
    return container;
  }
}
