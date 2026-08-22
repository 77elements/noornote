/**
 * Extract media URLs from text content
 * Single purpose: text → MediaContent[] (images, videos, YouTube)
 *
 * @param text - Raw text content to extract media from
 * @returns Array of MediaContent objects
 *
 * @example
 * extractMedia("Check this out https://example.com/image.jpg")
 * // => [{ type: 'image', url: 'https://example.com/image.jpg' }]
 */

// Re-export canonical MediaContent definition (single source of truth in NoteTypes.ts)
export type { MediaContent } from '../components/ui/types/NoteTypes';
import type { MediaContent } from '../components/ui/types/NoteTypes';

/**
 * Extract the clean media URL from a full URL that may contain query/tracking params.
 * Finds the last occurrence of the media extension and strips everything after it.
 * Example: "https://proxy.com/?u=https://img.com/photo.jpg&f=1&nofb=1" → "https://proxy.com/?u=https://img.com/photo.jpg"
 */
function extractCleanMediaUrl(url: string, extensions: string[]): string {
  // Find the last position of any media extension in the URL
  let lastExtEnd = -1;
  for (const ext of extensions) {
    const extPattern = `.${ext}`;
    const idx = url.toLowerCase().lastIndexOf(extPattern);
    if (idx !== -1) {
      const end = idx + extPattern.length;
      if (end > lastExtEnd) lastExtEnd = end;
    }
  }
  return lastExtEnd !== -1 ? url.substring(0, lastExtEnd) : url;
}

/** Regex for matching image URLs in text (global, for extraction) */
export const IMAGE_URL_REGEX =
  /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)(?:[?&][^\s]*)?/gi;

/** Check if a string is an image URL */
export function isImageUrl(text: string): boolean {
  return /^https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?[^\s]*)?$/i.test(
    text.trim()
  );
}

export function extractMedia(text: string): MediaContent[] {
  const media: MediaContent[] = [];

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const videoExts = ['mp4', 'webm', 'mov', 'avi'];
  const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];

  // Image patterns — capture full URL including any trailing params after extension
  IMAGE_URL_REGEX.lastIndex = 0;
  const images = text.match(IMAGE_URL_REGEX) || [];

  images.forEach(fullUrl => {
    media.push({
      type: 'image',
      url: extractCleanMediaUrl(fullUrl, imageExts),
      originalUrl: fullUrl,
    });
  });

  // Video patterns
  const videoRegex = /https?:\/\/[^\s]+\.(?:mp4|webm|mov|avi)(?:[?&][^\s]*)?/gi;
  const videos = text.match(videoRegex) || [];

  videos.forEach(fullUrl => {
    media.push({
      type: 'video',
      url: extractCleanMediaUrl(fullUrl, videoExts),
      originalUrl: fullUrl,
    });
  });

  // Audio patterns
  const audioRegex =
    /https?:\/\/[^\s]+\.(?:mp3|wav|ogg|flac|m4a|aac)(?:[?&][^\s]*)?/gi;
  const audios = text.match(audioRegex) || [];

  audios.forEach(fullUrl => {
    media.push({
      type: 'audio',
      url: extractCleanMediaUrl(fullUrl, audioExts),
      originalUrl: fullUrl,
    });
  });

  // YouTube detection (keep query params — v= is essential)
  // Accepts any subdomain (www, m, music, …) AND greedily consumes trailing
  // non-whitespace chars so originalUrl covers the ENTIRE URL including
  // tracking params (&t=, &pp=, &ab_channel=, …). Otherwise leftover
  // fragments survive the text replacement and leak into the rendered note.
  const youtubeRegex =
    /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)[^\s]*/gi;
  let match;
  while ((match = youtubeRegex.exec(text)) !== null) {
    media.push({
      type: 'video',
      url: match[0],
      originalUrl: match[0],
      thumbnail: `https://img.youtube.com/vi/${match[1]}/maxresdefault.jpg`,
    });
  }

  return media;
}

/**
 * Like extractMedia, but additionally parses NIP-92 `imeta` tags for the
 * NIP-68 `annotate-user` sub-tag and merges tagged pubkeys into the matching
 * media item. Used for kind 1 notes (kind 20 uses PictureNoteProcessor).
 *
 * Per NIP-92, the URL declared in an `imeta` tag MUST also appear in the
 * event content. If no match is found in the URL-derived media list, the
 * imeta entry is silently skipped (spec violation by the event author).
 *
 * Only `annotate-user` is parsed here — `dim`, `alt`, `blurhash`, etc. are
 * left untouched for kind 1 (no regression on existing rendering).
 */
export function extractMediaWithImeta(
  text: string,
  tags: string[][]
): MediaContent[] {
  const media = extractMedia(text);
  const imetaTags = tags.filter(tag => tag[0] === 'imeta');
  if (imetaTags.length === 0) return media;

  for (const tag of imetaTags) {
    let url = '';
    const taggedPubkeys: string[] = [];

    for (let i = 1; i < tag.length; i++) {
      const prop = tag[i];
      if (!prop) continue;
      const spaceIndex = prop.indexOf(' ');
      if (spaceIndex === -1) continue;
      const key = prop.substring(0, spaceIndex);
      const value = prop.substring(spaceIndex + 1);

      if (key === 'url') {
        url = value;
      } else if (key === 'annotate-user') {
        // NIP-68: "<pubkey_hex>:<x>:<y>"
        const annotMatch = value.match(/^([0-9a-f]{64}):\d+:\d+$/);
        if (annotMatch) {
          const pubkey = annotMatch[1]!;
          if (!taggedPubkeys.includes(pubkey)) taggedPubkeys.push(pubkey);
        }
      }
    }

    if (!url || taggedPubkeys.length === 0) continue;

    // Match against both the cleaned URL and the original URL (with tracking params)
    const match = media.find(m => m.url === url || m.originalUrl === url);
    if (match) {
      match.taggedPubkeys = [...(match.taggedPubkeys ?? []), ...taggedPubkeys];
    }
  }

  return media;
}
