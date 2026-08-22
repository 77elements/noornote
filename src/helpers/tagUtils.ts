/**
 * Tag extraction utilities for Nostr events
 * Replaces inline `tags.find(t => t[0] === 'X')?.[1] || ''` patterns
 */

/**
 * Get the first value of a tag by name.
 * Returns fallback (default: '') if tag not found.
 */
export function getTag(
  tags: string[][] | undefined,
  name: string,
  fallback: string = ''
): string {
  if (!tags) return fallback;
  return tags.find(t => t[0] === name)?.[1] || fallback;
}

/**
 * Get all values of tags with the given name.
 * Replaces `tags.filter(t => t[0] === 'X').map(t => t[1])`
 */
export function getTagValues(
  tags: string[][] | undefined,
  name: string
): string[] {
  if (!tags) return [];
  return tags.filter(t => t[0] === name).map(t => t[1] || '');
}
