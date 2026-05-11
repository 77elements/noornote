/**
 * Value sanitizers shared across the engine. Anything written into a
 * `style="…"` HTML attribute MUST go through `sanitizeStyleValue` — that
 * happens centrally in `buildInlineStyle`, but callers writing inline
 * styles directly (e.g. the dm-button alignment wrapper) also use this
 * directly.
 */

/**
 * Strip characters that could break out of `style="…"` or the CSS
 * declaration itself, plus a generous length cap. Surviving characters
 * cover normal CSS values: numbers, units, colours, var(), calc(),
 * gradients with multiple stops, etc.
 *
 * Additionally drop the value entirely if it contains a `url(...)` with
 * a dangerous scheme (javascript:, data:, vbscript:) — characters like
 * `:` are allowed for `var(--x)` and `calc()`, so the bracket-stripping
 * pass alone cannot block these. Browsers commonly refuse to execute
 * script-URLs inside `style="…"`, but CSP / browser-bug surface makes
 * defence-in-depth worthwhile.
 */
const MAX_STYLE_VALUE_LEN = 1000; // multi-stop gradients with var() refs add up
export function sanitizeStyleValue(raw: string): string {
  const stripped = raw.replace(/[;<>"'\\]/g, '').trim().slice(0, MAX_STYLE_VALUE_LEN);
  if (/url\s*\(\s*['"]?\s*(javascript|data|vbscript)\s*:/i.test(stripped)) return '';
  return stripped;
}

/**
 * Validate a CSS identifier (for `class` and `id` HTML attribute values).
 * Tokens must start with a letter and may contain letters, digits, hyphens
 * and underscores. Multi mode allows space-separated tokens (for `class`),
 * single mode rejects whitespace.
 *
 * Returns the cleaned value or empty string if no token survived.
 */
export function sanitizeCssIdent(raw: string, mode: 'single' | 'multi' = 'single'): string {
  const trimmed = raw.trim().slice(0, 80);
  if (!trimmed) return '';
  const tokenRe = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  if (mode === 'single') {
    return tokenRe.test(trimmed) ? trimmed : '';
  }
  const tokens = trimmed.split(/\s+/).filter(t => tokenRe.test(t)).slice(0, 5);
  return tokens.join(' ');
}
