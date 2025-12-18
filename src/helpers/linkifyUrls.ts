/**
 * Convert URLs to clickable links
 * Single purpose: HTML → HTML with linkified URLs
 *
 * @param html - HTML content with URLs
 * @returns HTML with URLs wrapped in <a> tags
 *
 * @example
 * linkifyUrls("Visit https://example.com")
 * // => 'Visit <a href="https://example.com" rel="noopener">https://example.com</a>'
 */

export function linkifyUrls(html: string): string {
  // Exclude quotes and > to prevent matching URLs inside href attributes
  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  // No target="_blank" - global handler in App.ts opens external links
  return html.replace(urlRegex, '<a href="$1" rel="noopener">$1</a>');
}