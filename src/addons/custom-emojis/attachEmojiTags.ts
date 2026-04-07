/**
 * attachEmojiTags
 *
 * Pure helper that scans content for `:shortcode:` patterns, looks each up in
 * a known emoji pack, and returns a new tags array with NIP-30
 * `["emoji", code, url]` entries appended for every match.
 *
 * Unknown shortcodes are left as text — no tag is added, the renderer leaves
 * them as plain text.
 */

import type { PersonalEmoji } from './EmojiService';

const SHORTCODE_REGEX = /:([a-zA-Z0-9_-]+):/g;

export function attachEmojiTags(
  content: string,
  baseTags: string[][],
  emojis: PersonalEmoji[]
): string[][] {
  if (!content || emojis.length === 0) return baseTags;

  const found = new Set<string>();
  let match: RegExpExecArray | null;
  // Reset lastIndex in case the regex is reused elsewhere
  SHORTCODE_REGEX.lastIndex = 0;
  while ((match = SHORTCODE_REGEX.exec(content)) !== null) {
    found.add(match[1]!);
  }

  if (found.size === 0) return baseTags;

  // Avoid duplicates if the caller already supplied an emoji tag for this code
  const existing = new Set(
    baseTags.filter(t => t[0] === 'emoji').map(t => t[1])
  );

  const out = [...baseTags];
  for (const code of found) {
    if (existing.has(code)) continue;
    const emoji = emojis.find(e => e.shortcode === code);
    if (emoji) out.push(['emoji', code, emoji.url]);
  }
  return out;
}
