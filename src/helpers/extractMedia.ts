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

export interface MediaContent {
  type: 'image' | 'video' | 'audio';
  url: string;
  originalUrl?: string; // Original URL from text (with tracking params), used for text replacement
  alt?: string;
  thumbnail?: string;
  dimensions?: { width: number; height: number };
}

/**
 * Extract the clean media URL from a full URL that may contain query/tracking params.
 * Finds the last occurrence of the media extension and strips everything after it.
 * Example: "https://proxy.com/?u=https://img.com/photo.jpg&f=1&nofb=1" → "https://proxy.com/?u=https://img.com/photo.jpg"
 */
function extractCleanMediaUrl(url: string, extensions: string[]): string {
  // Find the last position of any media extension in the URL
  let lastExtEnd = -1;
  for (const ext of extensions) {
    const extPattern = '.' + ext;
    const idx = url.toLowerCase().lastIndexOf(extPattern);
    if (idx !== -1) {
      const end = idx + extPattern.length;
      if (end > lastExtEnd) lastExtEnd = end;
    }
  }
  return lastExtEnd !== -1 ? url.substring(0, lastExtEnd) : url;
}

/** Regex for matching image URLs in text (global, for extraction) */
export const IMAGE_URL_REGEX = /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)(?:[?&][^\s]*)?/gi;

/** Check if a string is an image URL */
export function isImageUrl(text: string): boolean {
  return /^https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?[^\s]*)?$/i.test(text.trim());
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
      originalUrl: fullUrl
    });
  });

  // Video patterns
  const videoRegex = /https?:\/\/[^\s]+\.(?:mp4|webm|mov|avi)(?:[?&][^\s]*)?/gi;
  const videos = text.match(videoRegex) || [];

  videos.forEach(fullUrl => {
    media.push({
      type: 'video',
      url: extractCleanMediaUrl(fullUrl, videoExts),
      originalUrl: fullUrl
    });
  });

  // Audio patterns
  const audioRegex = /https?:\/\/[^\s]+\.(?:mp3|wav|ogg|flac|m4a|aac)(?:[?&][^\s]*)?/gi;
  const audios = text.match(audioRegex) || [];

  audios.forEach(fullUrl => {
    media.push({
      type: 'audio',
      url: extractCleanMediaUrl(fullUrl, audioExts),
      originalUrl: fullUrl
    });
  });

  // YouTube detection (keep query params — v= is essential)
  // Accepts any subdomain (www, m, music, …) so leftover URL fragments don't survive into the rendered text
  const youtubeRegex = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/gi;
  let match;
  while ((match = youtubeRegex.exec(text)) !== null) {
    media.push({
      type: 'video',
      url: match[0],
      originalUrl: match[0],
      thumbnail: `https://img.youtube.com/vi/${match[1]}/maxresdefault.jpg`
    });
  }

  return media;
}
