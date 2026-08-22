/**
 * PictureNoteProcessor - Process kind:20 picture events (NIP-68)
 * Extracts images from imeta tags, title, and renders through OriginalNoteRenderer
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import type { MediaContent } from '../../../helpers/renderMediaContent';
import type { ProcessedContent } from '../../../services/ContentProcessor';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';

export class PictureNoteProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    const authorProfile =
      PictureNoteProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);

    const processedContent =
      PictureNoteProcessor.contentProcessor.processContentWithTags(
        event.content,
        event.tags
      );

    PictureNoteProcessor.prependPictureContent(processedContent, event.tags);

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
        name: authorProfile.name,
        display_name: authorProfile.display_name,
        picture: authorProfile.picture,
      };
    }

    return result;
  }

  /**
   * Prepend title + imeta image placeholders to processed content
   * Mutates processedContent in place: prepends HTML, pushes image media
   */
  static prependPictureContent(
    processedContent: ProcessedContent,
    tags: string[][]
  ): void {
    const imageMedia = PictureNoteProcessor.extractImagesFromTags(tags);
    const title = getTag(tags, 'title');

    let html = '';

    if (title) {
      html += `<h3 class="picture-note-title h6">${escapeHtml(title)}</h3>`;
    }

    const existingMediaCount = processedContent.media.length;
    imageMedia.forEach((image, idx) => {
      processedContent.media.push(image);
      html += `__MEDIA_${existingMediaCount + idx}__`;
    });

    processedContent.html = html + processedContent.html;
  }

  /**
   * Extract image MediaContent from imeta tags (NIP-92)
   * Format: ["imeta", "url https://...", "m image/jpeg", "dim 1024x768", "alt description", ...]
   * NIP-68: ["imeta", "url https://...", "annotate-user <pubkey_hex>:<x>:<y>", ...]
   */
  static extractImagesFromTags(tags: string[][]): MediaContent[] {
    const media: MediaContent[] = [];

    const imetaTags = tags.filter(tag => tag[0] === 'imeta');

    for (const tag of imetaTags) {
      let url = '';
      let alt = '';
      let dimensions: { width: number; height: number } | undefined;
      const taggedPubkeys: string[] = [];

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
          case 'annotate-user': {
            // NIP-68: "<pubkey_hex>:<x>:<y>"
            const annotMatch = value.match(/^([0-9a-f]{64}):\d+:\d+$/);
            if (annotMatch) {
              const pubkey = annotMatch[1]!;
              if (!taggedPubkeys.includes(pubkey)) taggedPubkeys.push(pubkey);
            }
            break;
          }
        }
      }

      if (url) {
        const item: MediaContent = { type: 'image', url };
        if (alt) item.alt = alt;
        if (dimensions) item.dimensions = dimensions;
        if (taggedPubkeys.length > 0) item.taggedPubkeys = taggedPubkeys;
        media.push(item);
      }
    }

    return media;
  }
}
