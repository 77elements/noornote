/**
 * Escape HTML entities to prevent XSS
 * Single purpose: text → escaped HTML-safe text
 *
 * @param text - Raw text that may contain HTML characters
 * @returns HTML-escaped safe text
 *
 * @example
 * escapeHtml("<script>alert('xss')</script>")
 * // => "&lt;script&gt;alert('xss')&lt;/script&gt;"
 */

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape text for safe use in HTML attributes
 * Covers &, ", ', <, > which can break out of attribute context
 */
export function escapeHtmlAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape a URL for a CSS `url('...')` inside an HTML `style="..."` attribute.
 * HTML-entity escaping doesn't work in CSS, so strip `"`/newlines and
 * backslash-escape `\` and the CSS `'` delimiter.
 */
export function escapeCssUrl(url: string): string {
  return url
    .replace(/[\r\n"]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}