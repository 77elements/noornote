/**
 * ArticleProcessor - Long-form content processor (NIP-23, kind 30023)
 * Processes articles as text notes for timeline display
 * Full article rendering is handled by ArticleView component
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';

export class ArticleProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Process article event as text note for preview
   * Full rendering is handled by ArticleView when viewing the article directly
   */
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    // Extract article metadata
    const title = event.tags.find(t => t[0] === 'title')?.[1] || 'Untitled Article';
    const summary = event.tags.find(t => t[0] === 'summary')?.[1] || '';

    // For timeline preview, show title and summary
    const previewContent = summary
      ? `# ${title}\n\n${summary}`
      : `# ${title}`;

    const authorProfile = ArticleProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);
    const processedContent = ArticleProcessor.contentProcessor.processContentWithTags(
      previewContent,
      event.tags
    );

    const result: ProcessedNote = {
      id: eventId,
      type: 'original',
      timestamp: event.created_at,
      author: {
        pubkey: event.pubkey
      },
      content: processedContent,
      rawEvent: event
    };

    if (authorProfile) {
      result.author.profile = {
        name: authorProfile.name,
        display_name: authorProfile.display_name,
        picture: authorProfile.picture
      };
    }

    return result;
  }
}
