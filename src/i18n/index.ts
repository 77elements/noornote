/**
 * i18n core — gettext-style runtime (WP1 of docs/todos/internationalization.md).
 *
 * Conventions (decided D1–D5):
 *  - Function-call style with %-placeholders: `_('Backed up %s notes', n)`.
 *    `%s` consumes arguments sequentially, `%1$s`… addresses explicitly.
 *  - msgid IS the English original string (no key indirection).
 *  - `_`/`tn`/`tp`/`tnp` do NOT escape — call sites keep the established
 *    escapeHtml discipline for dynamic values.
 *  - DiagLog/console/exception bodies stay English by design.
 *
 * Fallback chain: active catalog → plain msgid (English). Missing/fuzzy
 * translations therefore always degrade to English, never to nothing.
 *
 * Bootstrap: `initI18n()` in main.ts (before App init), re-applied on
 * `user:login` (language is a per-account setting).
 */

import {
  clearCatalogs,
  loadCatalog,
  contextKey,
  type Catalog,
} from './catalog';
import { dirFor, normalizeLocale, pluralIndex } from './plurals';

// NOTE: NO static service imports in this module. PerAccountLocalStorage and
// TypedEventBus are imported dynamically inside async functions on purpose —
// static imports would pull the app's service import graph (AuthService →
// lists/storage cycle; SystemLogger → Router → components chain) with i18n
// as the cycle entry, and i18n loads extremely early (main.ts).

let currentLocale = 'en';
let currentCatalog: Catalog | null = null;
let initialized = false;

// ── Placeholder interpolation ────────────────────────────────

const PLACEHOLDER_RE = /%(\d+)\$s|%s/g;

/** Coerce a placeholder argument to text (objects are not translatable). */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** Replace `%s` (sequential) and `%N$s` (explicit index) placeholders. */
function interpolate(template: string, args: unknown[]): string {
  if (args.length === 0 || !template.includes('%')) return template;
  let next = 0;
  return template.replace(PLACEHOLDER_RE, (match, numStr) => {
    if (numStr) {
      const value = toText(args[Number(numStr) - 1]);
      return args[Number(numStr) - 1] === undefined ? match : value;
    }
    const index = next;
    next += 1;
    return args[index] === undefined ? match : toText(args[index]);
  });
}

// ── Translation functions (sync — catalog must be preloaded) ─

/** Translate a simple string. */
export function _(msgid: string, ...args: unknown[]): string {
  const entry = currentCatalog?.[msgid];
  if (typeof entry === 'string' && entry !== '')
    return interpolate(entry, args);
  return interpolate(msgid, args);
}

/** Translate a string with plural forms. `n` is always available as `%s`. */
export function tn(
  singular: string,
  plural: string,
  n: number,
  ...args: unknown[]
): string {
  const entry = currentCatalog?.[singular];
  if (Array.isArray(entry)) {
    const chosen = entry[pluralIndex(currentLocale, n)] ?? '';
    if (chosen !== '') return interpolate(chosen, [n, ...args]);
  }
  return interpolate(n === 1 ? singular : plural, [n, ...args]);
}

/** Translate with a context qualifier (verb/noun disambiguation). */
export function tp(context: string, msgid: string, ...args: unknown[]): string {
  const keyed = currentCatalog?.[contextKey(context, msgid)];
  if (typeof keyed === 'string' && keyed !== '')
    return interpolate(keyed, args);
  return _(msgid, ...args);
}

/** Translate with context AND plural forms. */
export function tnp(
  context: string,
  singular: string,
  plural: string,
  n: number,
  ...args: unknown[]
): string {
  const keyed = currentCatalog?.[contextKey(context, singular)];
  if (Array.isArray(keyed)) {
    const chosen = keyed[pluralIndex(currentLocale, n)] ?? '';
    if (chosen !== '') return interpolate(chosen, [n, ...args]);
  }
  return tn(singular, plural, n, ...args);
}

// ── Locale state ─────────────────────────────────────────────

/** Active UI locale (defaults to `'en'` until `initI18n()` ran). */
export function getUiLocale(): string {
  return currentLocale;
}

/**
 * Pure state switch (no storage, no events). Used by the async bootstrap
 * path and directly by tests to inject catalogs.
 */
export function applyLocaleState(
  locale: string,
  catalog: Catalog | null
): void {
  currentLocale = locale;
  currentCatalog = catalog;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.documentElement.dir = dirFor(locale);
  }
}

/**
 * Async bootstrap: resolve the stored/system locale, load its catalog if
 * needed, apply html lang/dir. Re-runs on `user:login` (per-account setting).
 */
export async function initI18n(): Promise<void> {
  await applyStoredLocale();

  if (!initialized) {
    initialized = true;
    const { TypedEventBus } = await import('../core/TypedEventBus');
    TypedEventBus.getInstance().on('user:login', () => {
      void applyStoredLocale();
    });
  }
}

async function applyStoredLocale(): Promise<void> {
  const locale = await storedLocale();
  if (locale !== 'en') {
    const catalog = await loadCatalog(locale);
    applyLocaleState(locale, catalog);
  } else {
    applyLocaleState('en', null);
  }
}

async function storedLocale(): Promise<string> {
  const { PerAccountLocalStorage, StorageKeys } = await import(
    '../services/PerAccountLocalStorage'
  );
  const stored = PerAccountLocalStorage.getInstance().get<string>(
    StorageKeys.LANGUAGE,
    ''
  );
  if (stored) return normalizeLocale(stored);
  if (typeof navigator !== 'undefined') {
    return normalizeLocale(navigator.language);
  }
  return 'en';
}

/**
 * Change the UI language (Settings): persist per-account, load the catalog,
 * apply html lang/dir and notify listeners.
 */
export async function setUiLocale(locale: string): Promise<void> {
  const normalized = normalizeLocale(locale);
  const { PerAccountLocalStorage, StorageKeys } = await import(
    '../services/PerAccountLocalStorage'
  );
  PerAccountLocalStorage.getInstance().set(StorageKeys.LANGUAGE, normalized);
  const catalog = normalized !== 'en' ? await loadCatalog(normalized) : null;
  applyLocaleState(normalized, catalog);
  const { TypedEventBus } = await import('../core/TypedEventBus');
  TypedEventBus.getInstance().emit('settings:language-changed', {
    locale: normalized,
  });
}

/** Test helper: reset module state between tests. */
export function resetI18nForTests(): void {
  currentLocale = 'en';
  currentCatalog = null;
  clearCatalogs();
}

export { availableLanguages } from './plurals';
