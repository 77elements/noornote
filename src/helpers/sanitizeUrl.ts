/**
 * Restrict a user-supplied URL to a safe protocol allowlist.
 *
 * Used wherever user-controlled strings end up as `href` or `src` attributes
 * (NosPress button-CTA / link / nav-menu items, image / audio / video URLs,
 * etc.). `escapeHtmlAttr` only protects against attribute-context escape;
 * it does NOT block dangerous protocols. A `javascript:`-prefixed URL would
 * otherwise still render as a clickable XSS vector.
 *
 * Returns:
 *   - the trimmed URL if its protocol is allowed (http, https, mailto,
 *     nostr, lightning) OR if it is relative (no protocol component);
 *   - an empty string for any other input (including `javascript:`,
 *     `data:`, `vbscript:`, `file:`, malformed URLs).
 *
 * Empty input returns empty — the caller decides whether to render the
 * element with an empty href, hide it, or fall back.
 */

const ALLOWED_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'nostr:',
  'lightning:',
]);

const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

export function sanitizeUrl(url: string | undefined | null): string {
  const trimmed = (url || '').trim();
  if (!trimmed) return '';

  // Relative URL (no `protocol:` component) — pass through. Catches
  // `/foo`, `?q=1`, `#anchor`, `./path`, and bare `example.com/foo`.
  if (!PROTOCOL_RE.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (ALLOWED_PROTOCOLS.has(parsed.protocol)) return trimmed;
  } catch {
    // Malformed URL — treat as unsafe.
  }
  return '';
}
