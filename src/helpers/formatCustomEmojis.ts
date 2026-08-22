/**
 * Format Custom Emojis (NIP-30)
 * Replaces :shortcode: with <img> tags based on emoji tags from event
 */

import { escapeHtmlAttr } from './escapeHtml';

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
    .filter(
      (tag): tag is [string, string, string, ...string[]] =>
        tag[0] === 'emoji' && tag.length >= 3 && !!tag[1] && !!tag[2]
    )
    .map(tag => ({ shortcode: tag[1], url: tag[2] }));
}

/**
 * Replace :shortcode: in HTML with <img> tags
 * Only replaces shortcodes that have a matching emoji definition
 */
export function formatCustomEmojis(
  html: string,
  emojis: CustomEmoji[]
): string {
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
      // Escape URL for safety (attribute-context: covers & " ' < >)
      const safeUrl = escapeHtmlAttr(url);
      return `<img class="custom-emoji" src="${safeUrl}" alt=":${shortcode}:" title=":${shortcode}:" loading="lazy" />`;
    }
    // No matching emoji, keep original text
    return match;
  });
}

/**
 * Resolve a reaction event's emoji content to display HTML
 * For NIP-30 custom emojis (:shortcode: with emoji tags), returns an <img> tag
 * For standard emojis, returns the content as-is
 */
export function resolveReactionEmoji(event: {
  content: string;
  tags: string[][];
}): string {
  const content = event.content.trim();

  // Check for :shortcode: pattern (NIP-30 custom emoji)
  const match = content.match(/^:([a-zA-Z0-9_-]+):$/);
  if (match) {
    const shortcode = match[1];
    const emojiTag = event.tags.find(
      t => t[0] === 'emoji' && t[1] === shortcode
    );
    if (emojiTag && emojiTag[2]) {
      const safeUrl = escapeHtmlAttr(emojiTag[2]);
      return `<img class="custom-emoji" src="${safeUrl}" alt=":${shortcode}:" title=":${shortcode}:" loading="lazy" />`;
    }
  }

  // Escape non-shortcode content to prevent XSS via crafted reaction content
  const div = document.createElement('div');
  div.textContent = content;
  return div.innerHTML;
}
