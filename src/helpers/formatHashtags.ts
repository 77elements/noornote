/**
 * Format hashtags as clickable elements
 * Single purpose: HTML + hashtags[] → HTML with formatted hashtags
 *
 * @param html - HTML content
 * @param hashtags - Array of hashtag strings (without # prefix)
 * @returns HTML with hashtags wrapped in styled spans
 *
 * @example
 * formatHashtags("Hello #nostr world", ['nostr'])
 * // => 'Hello <span class="hashtag" data-tag="nostr">#nostr</span> world'
 */

export function formatHashtags(html: string, hashtags: string[]): string {
  hashtags.forEach(tag => {
    // Only match hashtags preceded by whitespace or at start of string
    // This prevents matching #hash inside URLs like example.com/path#hash
    html = html.replace(
      new RegExp(`(^|\\s)#${tag}(?=[\\s<]|$)`, 'g'),
      `$1<span class="hashtag" data-tag="${tag}">#${tag}</span>`
    );
  });
  return html;
}
