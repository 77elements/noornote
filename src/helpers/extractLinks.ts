/**
 * Extract and categorize links from text content
 * Single purpose: text → LinkPreview[]
 *
 * @param text - Raw text content to extract links from
 * @returns Array of LinkPreview objects with URL and domain
 *
 * @example
 * extractLinks("Visit https://example.com for info")
 * // => [{ url: 'https://example.com', domain: 'example.com' }]
 */

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  domain: string;
}

export function extractLinks(text: string): LinkPreview[] {
  const links: LinkPreview[] = [];
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const urls = text.match(urlRegex) || [];

  urls.forEach(rawUrl => {
    // Clean trailing characters that are often part of markdown/html syntax
    // Remove trailing: > ) , . ! ? ; :
    const url = rawUrl.replace(/[>),.\!?;:]+$/, '');

    try {
      const parsed = new URL(url);
      links.push({
        url,
        domain: parsed.hostname,
      });
    } catch (error) {
      console.warn('Invalid URL:', rawUrl);
    }
  });

  return links;
}
