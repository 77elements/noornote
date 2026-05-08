/**
 * NosPress Site Settings — site-wide config bucket (NIP-78 d-tag
 * `noornote/site-settings`).
 *
 * Holds everything that doesn't belong to a single page or block:
 * SEO/meta, theme palette overrides, foreign code injection. Persisted
 * locally per-account and mirrored to relays as a single replaceable
 * NIP-78 event.
 */

export const PALETTE_KEYS = ['color-1', 'color-2', 'color-3', 'color-4', 'color-5', 'color-6'] as const;
export type PaletteKey = typeof PALETTE_KEYS[number];

/** Deep Purple — the default theme palette as defined in `_themes.scss`
 *  (`:root`). Used as the visual baseline in the Global tab swatches: each
 *  unset palette slot in `NospressSiteSettings.theme.palette` is rendered
 *  with these values so the user sees what they're overriding. */
export const DEFAULT_PALETTE: Record<PaletteKey, string> = {
  'color-1': '#0f0d23',
  'color-2': '#252343',
  'color-3': '#9b79b9',
  'color-4': '#dc85ad',
  'color-5': '#ede2da',
  'color-6': '#7dd87d',
};

export interface NospressSiteMeta {
  /** Display name of the site, used as a brand suffix in the document
   *  title: `<pageTitle> — <siteName>`. If empty, the page title shows
   *  alone. */
  siteName?: string;
  /** Site-wide default `<meta name="description">`. Overridable per page. */
  description?: string;
  /** Default OG image URL for sharing previews. */
  ogImage?: string;
  /** Favicon URL — applied via `<link rel="icon">`. */
  favicon?: string;
  /** Twitter card type. */
  twitterCard?: 'summary' | 'summary_large_image';
  /** Free-form additional `<meta>` tags. Each entry renders as
   *  `<meta name="<name>" content="<content>">`. Used for verification
   *  meta tags, analytics opt-outs, custom NIP-05 metadata, etc. */
  customTags?: Array<{ name: string; content: string }>;
}

export interface NospressSiteTheme {
  /** Per-site palette override. Keys are CSS-variable names without the
   *  `--` prefix; values are any valid CSS color. */
  palette?: Partial<Record<PaletteKey, string>>;
  /** Optional CSS `font-family` value applied to the public site root. */
  fontFamily?: string;
}

export interface NospressSiteInjection {
  /** Raw HTML appended to `<head>` (analytics scripts, verification meta
   *  tags, custom fonts). User injects code into their own page — owner
   *  is responsible for what they ship. */
  headSnippet?: string;
  /** Raw HTML appended just before `</body>`. */
  bodyEndSnippet?: string;
  /** External stylesheet URLs — rendered as `<link rel="stylesheet">`. */
  cssLinks?: string[];
  /** External script URLs — rendered as `<script src="..." async>`. */
  jsScripts?: string[];
}

/** A user-defined breakpoint — name + media-query shape. The user picks
 *  these in the Global tab; later they're consumed by per-block style
 *  variants and by Custom CSS via `@media`-helpers. Max 5 enforced in UI. */
export type BreakpointType = 'min' | 'max' | 'between';
export interface NospressBreakpoint {
  /** Free-form identifier (e.g. 'tablet', 'mobile'). */
  name: string;
  type: BreakpointType;
  /** CSS length, e.g. `768px`, `48rem`. */
  value: string;
  /** Upper bound — only used when `type === 'between'`. */
  value2?: string;
}

export interface NospressSiteSettings {
  version: 1;
  meta?: NospressSiteMeta;
  theme?: NospressSiteTheme;
  injection?: NospressSiteInjection;
  /** Site-wide Custom CSS — applies to every page (home, sub-pages,
   *  global header / footer, per-page header / footer). Replaces the
   *  legacy per-page `NospressPageV2.customCss` field; first read of a
   *  legacy `page.customCss` migrates it here. */
  customCss?: string;
  /** Responsive-design breakpoints. Cap of 5 enforced by the editor UI. */
  breakpoints?: NospressBreakpoint[];
}

export const EMPTY_SITE_SETTINGS: NospressSiteSettings = { version: 1 };

/** Type guard for events fetched from relays. Tolerates extra fields and
 *  missing optional sub-objects; returns false only for shapes that can't
 *  be reasoned about safely. */
export function isSiteSettings(data: unknown): data is NospressSiteSettings {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { version?: unknown };
  if (obj.version !== 1) return false;
  return true;
}

/** True if the settings carry any meaningful content (used by the public
 *  page to decide whether to apply or skip the head-injection step). */
export function hasSiteSettingsContent(s: NospressSiteSettings | null | undefined): boolean {
  if (!s) return false;
  const m = s.meta;
  if (m && (m.siteName || m.description || m.ogImage || m.favicon || m.twitterCard || (m.customTags?.length ?? 0) > 0)) return true;
  const t = s.theme;
  if (t && (t.fontFamily || (t.palette && Object.keys(t.palette).length > 0))) return true;
  const i = s.injection;
  if (i && (i.headSnippet || i.bodyEndSnippet || (i.cssLinks?.length ?? 0) > 0 || (i.jsScripts?.length ?? 0) > 0)) return true;
  if (s.customCss && s.customCss.trim().length > 0) return true;
  if ((s.breakpoints?.length ?? 0) > 0) return true;
  return false;
}
