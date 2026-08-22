/**
 * Render Post Preview Helper
 * Creates HTML preview of post content before publishing
 *
 * Pure helper function following NPM-package-ready standards:
 * - Single responsibility
 * - No side effects
 * - Clear TypeScript interfaces
 * - JSDoc documentation
 * - No local imports (only external libs)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NoteProcessor } from '../components/ui/note-processing/NoteProcessor';
import { replaceMediaPlaceholders } from './renderMediaContent';
import { replaceBolt11Placeholders } from './renderBolt11';

export interface PreviewOptions {
  content: string;
  pubkey: string;
  isNSFW?: boolean;
  /** Optional extra tags merged into the mock event (e.g. NIP-30 emoji tags) */
  extraTags?: string[][];
}

/**
 * Render post content preview as HTML
 *
 * @param options - Preview options (content and pubkey)
 * @returns HTML string with formatted preview
 *
 * @example
 * const preview = renderPostPreview({
 *   content: 'Hello #nostr with https://example.com/image.jpg',
 *   pubkey: '...'
 * });
 * // Returns: '<p>Hello <a href="#">#nostr</a> with</p><img src="..." />'
 */
export function renderPostPreview(options: PreviewOptions): string {
  if (!options.content.trim()) {
    return '<p class="post-note-preview-empty">Nothing to preview yet...</p>';
  }

  // Create mock Nostr event for processing
  const mockEvent: NostrEvent = {
    id: 'preview',
    pubkey: options.pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: options.extraTags ?? [],
    content: options.content,
    sig: '',
  };

  // Process note content (linkify, hashtags, media extraction, etc.)
  const processedNote = NoteProcessor.process(mockEvent);

  // Replace media placeholders in HTML with actual media elements
  // This ensures correct order (media appears where placeholder is) and no leftover __MEDIA_X__
  let htmlWithMedia = replaceMediaPlaceholders(
    processedNote.content.html,
    processedNote.content.media,
    options.isNSFW || false
  );
  htmlWithMedia = replaceBolt11Placeholders(
    htmlWithMedia,
    processedNote.content.bolt11Invoices
  );

  return htmlWithMedia;
}
