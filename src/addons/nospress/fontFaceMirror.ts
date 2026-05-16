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

import type { NospressCustomFont } from './blocks/siteSettings';

const START_MARKER = '/* @font-face-start (auto, edit via Global tab) */';
const END_MARKER = '/* @font-face-end */';

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
