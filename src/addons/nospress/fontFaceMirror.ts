/**
 * @font-face mirror — keeps a marker-fenced block at the top of siteSettings.customCss
 * in sync with siteSettings.theme.customFonts. Idempotent.
 *
 * Convention:
 *   /* @font-face-start (auto, edit via Global tab) *\/
 *   @font-face { … }
 *   …
 *   /* @font-face-end *\/
 *
 * User-edited CSS lives below the end marker. If the block is missing it is
 * prepended; if it exists it is replaced. Removing all custom fonts strips
 * the block entirely (no orphan markers).
 */

import { SITE_DEFAULT_FONT_PICK, type NospressCustomFont, type NospressSiteTheme } from './blocks/siteSettings';

const START_MARKER = '/* @font-face-start (auto, edit via Global tab) */';
const END_MARKER = '/* @font-face-end */';
const BODY_START_MARKER = '/* @fonts-body-start (auto, edit via Global tab) */';
const BODY_END_MARKER = '/* @fonts-body-end */';

/** Build the `@font-face { … }` lines for one font. */
function buildFontFaceRule(font: NospressCustomFont): string {
  const parts: string[] = [];
  parts.push(`  font-family: ${cssQuote(font.family)};`);
  parts.push(`  src: url(${cssQuoteUrl(font.src)}) format('${font.format}');`);
  if (font.weight) parts.push(`  font-weight: ${font.weight};`);
  if (font.style) parts.push(`  font-style: ${font.style};`);
  parts.push(`  font-display: swap;`);
  return `@font-face {\n${parts.join('\n')}\n}`;
}

/** Build the full marker-fenced block (empty string if no fonts). */
export function buildFontFaceBlock(fonts: NospressCustomFont[]): string {
  if (!fonts || fonts.length === 0) return '';
  const rules = fonts.map(buildFontFaceRule).join('\n\n');
  return `${START_MARKER}\n${rules}\n${END_MARKER}\n\n`;
}

/** Strip an existing marker-fenced block from CSS (returns the rest). */
export function stripFontFaceBlock(css: string): string {
  if (!css) return '';
  const startIdx = css.indexOf(START_MARKER);
  if (startIdx === -1) return css;
  const endIdx = css.indexOf(END_MARKER, startIdx);
  if (endIdx === -1) return css; // malformed — leave user CSS alone
  const tail = css.slice(endIdx + END_MARKER.length);
  // Eat one trailing blank line so successive remove→add cycles don't pile up newlines.
  return css.slice(0, startIdx).replace(/\n*$/, '') + tail.replace(/^\n+/, '\n');
}

/** Replace (or prepend) the marker block based on the given fonts list. */
export function mirrorFontFacesIntoCss(css: string, fonts: NospressCustomFont[]): string {
  const stripped = stripFontFaceBlock(css);
  const block = buildFontFaceBlock(fonts);
  if (!block) return stripped.trimStart();
  return block + stripped.trimStart();
}

/** Resolve the effective body font-family cascade. Returns the full CSS
 *  value (e.g. `'Zen Kurenaido', Arial, sans-serif`) or just `sans-serif`
 *  when nothing meaningful is configured. Pure: never touches state. */
export function buildBodyFontFamilyValue(theme: NospressSiteTheme | undefined): string {
  const fonts = theme?.customFonts ?? [];
  const siteDefault = (theme?.fontFamily ?? '').trim();
  const pickRaw = (theme?.defaultFontPick ?? '').trim();

  // Resolve auto-default if the explicit pick is empty / invalid.
  const customFamilies = fonts.map(f => f.family);
  let pick = pickRaw;
  const pickValid = pick === SITE_DEFAULT_FONT_PICK
    || (pick !== '' && customFamilies.includes(pick));
  if (!pickValid) {
    pick = customFamilies[0] ?? (siteDefault ? SITE_DEFAULT_FONT_PICK : '');
  }

  // Build the chain. Primary first; if primary is a custom font and a
  // site-default is set, append it as fallback; always end with sans-serif.
  const parts: string[] = [];
  if (pick === SITE_DEFAULT_FONT_PICK) {
    if (siteDefault) parts.push(siteDefault);
  } else if (pick !== '') {
    parts.push(`'${pick.replace(/'/g, "\\'")}'`);
    if (siteDefault) parts.push(siteDefault);
  }
  parts.push('sans-serif');
  return parts.join(', ');
}

/** Build the marker-fenced `body { font-family: …; }` block. Empty string
 *  when the cascade collapses to bare `sans-serif` AND no fonts at all are
 *  configured — but for consistency we always emit a block when called from
 *  the Save button, so callers control that distinction. */
export function buildBodyFontBlock(cascade: string): string {
  return `${BODY_START_MARKER}\nbody { font-family: ${cascade}; }\n${BODY_END_MARKER}\n\n`;
}

/** Strip the body-font marker block from CSS. */
export function stripBodyFontBlock(css: string): string {
  if (!css) return '';
  const startIdx = css.indexOf(BODY_START_MARKER);
  if (startIdx === -1) return css;
  const endIdx = css.indexOf(BODY_END_MARKER, startIdx);
  if (endIdx === -1) return css;
  const tail = css.slice(endIdx + BODY_END_MARKER.length);
  return css.slice(0, startIdx).replace(/\n*$/, '') + tail.replace(/^\n+/, '\n');
}

/** Replace (or prepend) the body-font marker block. */
export function mirrorBodyFontIntoCss(css: string, cascade: string): string {
  const stripped = stripBodyFontBlock(css);
  const block = buildBodyFontBlock(cascade);
  // Insert AFTER the @font-face block if present, else at the top, so the
  // body rule comes after the @font-face declarations it depends on.
  const faceEndIdx = stripped.indexOf(END_MARKER);
  if (faceEndIdx === -1) {
    return block + stripped.trimStart();
  }
  const insertPos = faceEndIdx + END_MARKER.length;
  // Walk past any blank lines so the inserted block keeps tidy spacing.
  let cut = insertPos;
  while (cut < stripped.length && stripped[cut] === '\n') cut++;
  return stripped.slice(0, cut) + block + stripped.slice(cut).trimStart();
}

// --- internal helpers --------------------------------------------------------

/** Wrap a CSS string in single quotes, escaping any embedded singles. */
function cssQuote(s: string): string {
  return `'${s.replace(/'/g, "\\'")}'`;
}

/** Quote a URL safely. Single-quote unless the URL contains one. */
function cssQuoteUrl(url: string): string {
  if (url.includes("'")) return `"${url.replace(/"/g, '\\"')}"`;
  return `'${url}'`;
}
