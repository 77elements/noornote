/**
 * Format Custom Emojis (NIP-30)
 * Replaces :shortcode: with <img> tags based on emoji tags from event
 */

export interface CustomEmoji {
  shortcode: string;
  url: string;
}

/**
 * Extract custom emojis from event tags
 * NIP-30 format: ["emoji", "shortcode", "https://example.com/emoji.png"]
 */
export function extractCustomEmojis(tags: string[][]): CustomEmoji[] {
  return tags
    .filter((tag): tag is [string, string, string, ...string[]] =>
      tag[0] === 'emoji' && tag.length >= 3 && !!tag[1] && !!tag[2]
    )
    .map(tag => ({ shortcode: tag[1], url: tag[2] }));
}

/**
 * Replace :shortcode: in HTML with <img> tags
 * Only replaces shortcodes that have a matching emoji definition
 */
export function formatCustomEmojis(html: string, emojis: CustomEmoji[]): string {
  if (!emojis.length) return html;

  // Create a map for quick lookup
  const emojiMap = new Map<string, string>();
  emojis.forEach(emoji => {
    emojiMap.set(emoji.shortcode, emoji.url);
  });

  // Regex to match :shortcode: patterns (alphanumeric, underscores, hyphens)
  const regex = /:([a-zA-Z0-9_-]+):/g;

  return html.replace(regex, (match, shortcode) => {
    const url = emojiMap.get(shortcode);
    if (url) {
      // Escape URL for safety
      const safeUrl = url.replace(/"/g, '&quot;');
      return `<img class="custom-emoji" src="${safeUrl}" alt=":${shortcode}:" title=":${shortcode}:" loading="lazy" />`;
    }
    // No matching emoji, keep original text
    return match;
  });
}
