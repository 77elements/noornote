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
  alt?: string;
  thumbnail?: string;
  dimensions?: { width: number; height: number };
}

export function extractMedia(text: string): MediaContent[] {
  const media: MediaContent[] = [];

  // Image patterns
  const imageRegex = /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?[^\s]*)?/gi;
  const images = text.match(imageRegex) || [];

  images.forEach(url => {
    media.push({
      type: 'image',
      url: url
    });
  });

  // Video patterns
  const videoRegex = /https?:\/\/[^\s]+\.(?:mp4|webm|mov|avi)(?:\?[^\s]*)?/gi;
  const videos = text.match(videoRegex) || [];

  videos.forEach(url => {
    media.push({
      type: 'video',
      url: url
    });
  });

  // Audio patterns
  const audioRegex = /https?:\/\/[^\s]+\.(?:mp3|wav|ogg|flac|m4a|aac)(?:\?[^\s]*)?/gi;
  const audios = text.match(audioRegex) || [];

  audios.forEach(url => {
    media.push({
      type: 'audio',
      url: url
    });
  });

  // YouTube detection
  const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/gi;
  let match;
  while ((match = youtubeRegex.exec(text)) !== null) {
    media.push({
      type: 'video',
      url: match[0],
      thumbnail: `https://img.youtube.com/vi/${match[1]}/maxresdefault.jpg`
    });
  }

  return media;
}