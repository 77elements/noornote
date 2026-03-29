/**
 * FileMetadataProcessor - Process kind:1063 file metadata events (NIP-94)
 * Extracts file URL and MIME type from tags, renders as image/video/audio or download link
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import type { MediaContent } from '../../../helpers/renderMediaContent';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';

export class FileMetadataProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    const authorProfile = FileMetadataProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);

    const processedContent = FileMetadataProcessor.contentProcessor.processContentWithTags(
      event.content,
      event.tags
    );

    FileMetadataProcessor.prependFileContent(processedContent, event.tags);

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

  /**
   * Extract file info from NIP-94 tags and prepend media or download link
   * Tags: ["url", "https://..."], ["m", "video/mp4"], ["dim", "1920x1080"], ["alt", "..."], ["size", "12345"]
   */
  static prependFileContent(processedContent: import('../../../services/ContentProcessor').ProcessedContent, tags: string[][]): void {
    const url = tags.find(tag => tag[0] === 'url')?.[1];
    if (!url) return;

    const mimeType = getTag(tags, 'm');
    const alt = getTag(tags, 'alt');
    const title = getTag(tags, 'title');
    const size = getTag(tags, 'size');
    const dimTag = getTag(tags, 'dim');

    let dimensions: { width: number; height: number } | undefined;
    const dimMatch = dimTag.match(/^(\d+)x(\d+)$/);
    if (dimMatch) {
      dimensions = { width: parseInt(dimMatch[1]!), height: parseInt(dimMatch[2]!) };
    }

    let html = '';

    if (title) {
      html += `<h3 class="file-metadata-title h6">${escapeHtml(title)}</h3>`;
    }

    const mediaType = FileMetadataProcessor.getMediaType(mimeType, url);

    if (mediaType) {
      const mediaItem: MediaContent = { type: mediaType, url };
      if (alt) mediaItem.alt = alt;
      if (dimensions) mediaItem.dimensions = dimensions;

      const existingMediaCount = processedContent.media.length;
      processedContent.media.push(mediaItem);
      html += `__MEDIA_${existingMediaCount}__`;
    } else {
      // Non-media file: render as download link
      const fileName = FileMetadataProcessor.extractFileName(url);
      const sizeStr = size ? ` (${FileMetadataProcessor.formatFileSize(parseInt(size))})` : '';
      html += `<div class="file-metadata-download"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="btn">&#x1F4CE; ${escapeHtml(fileName)}${sizeStr}</a></div>`;
    }

    processedContent.html = html + processedContent.html;
  }

  /**
   * Determine media type from MIME type, with URL extension fallback
   */
  private static getMediaType(mimeType: string, url: string): 'image' | 'video' | 'audio' | null {
    if (mimeType) {
      if (mimeType.startsWith('image/')) return 'image';
      if (mimeType.startsWith('video/')) return 'video';
      if (mimeType.startsWith('audio/')) return 'audio';
    }

    // Fallback: guess from URL extension
    const ext = url.split('.').pop()?.toLowerCase().split('?')[0];
    if (!ext) return null;

    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext)) return 'audio';

    return null;
  }

  private static extractFileName(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split('/');
      return decodeURIComponent(segments[segments.length - 1] || 'file');
    } catch {
      return 'file';
    }
  }

  private static formatFileSize(bytes: number): string {
    if (isNaN(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}
