/**
 * ArticleProcessor - Long-form content processor (NIP-23, kind 30023)
 * Processes articles as text notes for timeline display
 * Full article rendering is handled by ArticleView component
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { buildProcessedNote } from './processedNoteFactory';
import { getTag } from '../../../helpers/tagUtils';

export class ArticleProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Process article event as text note for preview
   * Full rendering is handled by ArticleView when viewing the article directly
   */
  static process(event: NostrEvent): ProcessedNote {
    // Extract article metadata
    const title = getTag(event.tags, 'title', 'Untitled Article');
    const summary = getTag(event.tags, 'summary');

    // For timeline preview, show title and summary
    const previewContent = summary ? `# ${title}\n\n${summary}` : `# ${title}`;

    const processedContent =
      ArticleProcessor.contentProcessor.processContentWithTags(
        previewContent,
        event.tags
      );

    return buildProcessedNote(event, {
      type: 'original',
      content: processedContent,
    });
  }
}
