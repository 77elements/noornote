/**
 * VideoNoteProcessor - Process kind:21 (landscape) and kind:22 (portrait) video events (NIP-71)
 * Extracts video from imeta tags, title, duration, and renders through OriginalNoteRenderer
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import type { MediaContent } from '../../../helpers/renderMediaContent';
import {
  ContentProcessor,
  type ProcessedContent,
} from '../../../services/ContentProcessor';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';

export class VideoNoteProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Process kind:21 or kind:22 video event
   * SYNCHRONOUS - no blocking calls
   */
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    const authorProfile =
      VideoNoteProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);

    const processedContent =
      VideoNoteProcessor.contentProcessor.processContentWithTags(
        event.content,
        event.tags
      );

    VideoNoteProcessor.prependVideoContent(processedContent, event.tags);

    const result: ProcessedNote = {
      id: eventId,
      type: 'original',
      timestamp: event.created_at,
      author: {
        pubkey: event.pubkey,
      },
      content: processedContent,
      rawEvent: event,
    };

    if (authorProfile) {


      result.author.profile = {


        ...(authorProfile.name !== undefined && { name: authorProfile.name }),


        ...(authorProfile.display_name !== undefined && { display_name: authorProfile.display_name }),


        ...(authorProfile.picture !== undefined && { picture: authorProfile.picture }),


      };


    }

    return result;
  }

  /**
   * Prepend video title + imeta video placeholders to processed content
   * Shared by VideoNoteProcessor.process() and QuotedNoteRenderer.createQuoteBox()
   * Mutates processedContent in place: prepends HTML, pushes video media
   */
  static prependVideoContent(
    processedContent: ProcessedContent,
    tags: string[][]
  ): void {
    const videoMedia = VideoNoteProcessor.extractVideoFromTags(tags);
    const title = getTag(tags, 'title');

    let html = '';

    if (title) {
      html += `<h3 class="video-note-title h6">${escapeHtml(title)}</h3>`;
    }

    const existingMediaCount = processedContent.media.length;
    videoMedia.forEach((video, idx) => {
      processedContent.media.push(video);
      html += `__MEDIA_${existingMediaCount + idx}__`;
    });

    processedContent.html = html + processedContent.html;
  }

  /**
   * Extract video MediaContent from imeta tags (NIP-92)
   * Format: ["imeta", "url https://...", "m video/mp4", "dim 1920x1080", "image https://thumb.jpg"]
   */
  static extractVideoFromTags(tags: string[][]): MediaContent[] {
    const media: MediaContent[] = [];

    const imetaTags = tags.filter(tag => tag[0] === 'imeta');

    for (const tag of imetaTags) {
      let url = '';
      let thumbnail = '';
      let alt = '';
      let dimensions: { width: number; height: number } | undefined;

      for (let i = 1; i < tag.length; i++) {
        const prop = tag[i];
        if (!prop) continue;

        const spaceIndex = prop.indexOf(' ');
        if (spaceIndex === -1) continue;

        const key = prop.substring(0, spaceIndex);
        const value = prop.substring(spaceIndex + 1);

        switch (key) {
          case 'url':
            url = value;
            break;
          case 'image':
          case 'thumb':
            thumbnail = value;
            break;
          case 'alt':
            alt = value;
            break;
          case 'dim': {
            const dimMatch = value.match(/^(\d+)x(\d+)$/);
            if (dimMatch) {
              dimensions = {
                width: parseInt(dimMatch[1]!),
                height: parseInt(dimMatch[2]!),
              };
            }
            break;
          }
        }
      }

      if (url) {
        const item: MediaContent = { type: 'video', url };
        if (thumbnail) item.thumbnail = thumbnail;
        if (alt) item.alt = alt;
        if (dimensions) item.dimensions = dimensions;
        media.push(item);
      }
    }

    // Fallback: check for direct url/thumb tags if no imeta found
    if (media.length === 0) {
      const urlTag = tags.find(tag => tag[0] === 'url');
      if (urlTag?.[1]) {
        const thumbTag = tags.find(
          tag => tag[0] === 'thumb' || tag[0] === 'image'
        );
        const item: MediaContent = { type: 'video', url: urlTag[1] };
        if (thumbTag?.[1]) item.thumbnail = thumbTag[1];
        media.push(item);
      }
    }

    return media;
  }
}
