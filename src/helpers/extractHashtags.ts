/**
 * Extract hashtags from text content
 * Single purpose: text → string[] (hashtags without # prefix)
 *
 * @param text - Raw text content to extract hashtags from
 * @returns Array of hashtag strings (without # prefix)
 *
 * @example
 * extractHashtags("Hello #nostr #bitcoin world")
 * // => ['nostr', 'bitcoin']
 */

export function extractHashtags(text: string): string[] {
  const hashtagRegex = /#[a-zA-Z0-9_]+/g;
  const hashtags = text.match(hashtagRegex) || [];
  return hashtags.map(tag => tag.slice(1)); // Remove # prefix
}
