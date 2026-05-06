/**
 * NosPress Site Settings — site-wide config bucket (NIP-78 d-tag
 * `noornote/site-settings`).
 *
 * Holds everything that doesn't belong to a single page or block:
 * SEO/meta, theme palette overrides, foreign code injection. Persisted
 * locally per-account and mirrored to relays as a single replaceable
 * NIP-78 event.
 */

const PALETTE_KEYS = ['color-1', 'color-2', 'color-3', 'color-4', 'color-5', 'color-6'] as const;
type PaletteKey = typeof PALETTE_KEYS[number];

export interface NospressSiteMeta {
  /** Display name of the site (used in `titleTemplate`). */
  siteName?: string;
  /** Title template with `{pageTitle}` / `{siteName}` tokens. Default
   *  `'{pageTitle} — {siteName}'` when both are set, otherwise just one. */
  titleTemplate?: string;
  /** Site-wide default `<meta name="description">`. Overridable per page. */
  description?: string;
  /** Default OG image URL for sharing previews. */
  ogImage?: string;
  /** Favicon URL — applied via `<link rel="icon">`. */
  favicon?: string;
  /** Twitter card type. */
  twitterCard?: 'summary' | 'summary_large_image';
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

export interface NospressSiteSettings {
  version: 1;
  meta?: NospressSiteMeta;
  theme?: NospressSiteTheme;
  injection?: NospressSiteInjection;
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
  if (m && (m.siteName || m.titleTemplate || m.description || m.ogImage || m.favicon || m.twitterCard)) return true;
  const t = s.theme;
  if (t && (t.fontFamily || (t.palette && Object.keys(t.palette).length > 0))) return true;
  const i = s.injection;
  if (i && (i.headSnippet || i.bodyEndSnippet || (i.cssLinks?.length ?? 0) > 0 || (i.jsScripts?.length ?? 0) > 0)) return true;
  return false;
}
