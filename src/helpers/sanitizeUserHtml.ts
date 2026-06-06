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

/**
 * Sanitize marked-rendered article HTML (NIP-23). Single whitelist shared by
 * ArticleView (reading view) and ArticleEditorView (preview tab) so the
 * preview always shows exactly what the published article will show.
 */
export function sanitizeArticleHtml(input: string): string {
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li',
      'strong', 'em', 'b', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote',
      'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'span', 'div', 'section'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel', 'loading'],
    ALLOW_DATA_ATTR: false
  });
}
