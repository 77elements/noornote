/**
 * Catalog loading for the i18n core.
 *
 * Catalogs are compiled from `src/i18n/po/<lang>.po` into JSON chunks by
 * `scripts/i18n-compile.ts` (po sources stay in the repo for translators,
 * compiled JSON is a build artifact — not committed). This module resolves
 * the per-language chunk lazily via import.meta.glob (same pattern as the
 * addon runtimes), caches it, and supports direct injection for tests.
 *
 * Catalog shape (flattened gettext):
 *   { "msgid": "msgstr",
 *     "context\u0004msgid": "msgstr",
 *     "plural-msgid": ["form0", "form1", …] }
 */

export type CatalogEntry = string | string[];
export type Catalog = Record<string, CatalogEntry>;

const CONTEXT_SEPARATOR = '\u0004';

/** Context-qualified catalog key (gettext stores msgctxt with a EOT separator). */
export function contextKey(context: string, msgid: string): string {
  return `${context}${CONTEXT_SEPARATOR}${msgid}`;
}

const loaders = import.meta.glob('./locales/*.json') as Record<
  string,
  () => Promise<{ default: Catalog }>
>;

const cache = new Map<string, Catalog>();

/** Inject a catalog directly (tests, runtime prefetch). */
export function setCatalog(lang: string, catalog: Catalog): void {
  cache.set(lang, catalog);
}

/** Drop all cached/injected catalogs (test reset). */
export function clearCatalogs(): void {
  cache.clear();
}

export function getCatalog(lang: string): Catalog | null {
  return cache.get(lang) ?? null;
}

/** Load and cache a language chunk. `null` = no compiled catalog exists. */
export async function loadCatalog(lang: string): Promise<Catalog | null> {
  const cached = cache.get(lang);
  if (cached) return cached;

  const loader = loaders[`./locales/${lang}.json`];
  if (!loader) return null;

  const mod = await loader();
  cache.set(lang, mod.default);
  return mod.default;
}
