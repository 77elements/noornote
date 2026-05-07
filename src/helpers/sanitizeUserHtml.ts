import DOMPurify from 'dompurify';

/**
 * Sanitize untrusted HTML coming from user-controlled fields (NosPress
 * block text, captions, list items, button labels, …).
 *
 * Centralizes the project's HTML-sanitization policy so future tightening
 * (narrower ALLOWED_TAGS / ALLOWED_ATTR, custom hooks) lives in one place
 * instead of being scattered across every block renderer. DOMPurify
 * defaults already block `<script>`, `<style>`, `<iframe>`, on*-handlers,
 * and `javascript:` href/src — so a wrap with defaults is already a net
 * security baseline; this file is the single chokepoint where that
 * baseline can be raised.
 */
export function sanitizeUserHtml(input: string | undefined | null): string {
  if (!input) return '';
  return DOMPurify.sanitize(input);
}
