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