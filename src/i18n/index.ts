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
 * Locale-aware number formatting for user-facing counts (followers, sats,
 * cache sizes …). Uses the active UI locale, so `1,500` (en) vs `1.500` (de)
 * follows the language the user picked. Falls back to `'en'` like everything
 * else before `initI18n()` ran.
 */
export function formatNumber(value: number): string {
  try {
    return value.toLocaleString(currentLocale);
  } catch {
    return value.toLocaleString('en');
  }
}

// ── RTL preview (QA affordance for RTL readiness, WP10) ──────

const RTL_PREVIEW_KEY = 'noornote_rtl_preview';

/**
 * Force `dir="rtl"` on `<html>` regardless of the active locale, so layout
 * mirroring can be verified without an RTL catalog (pseudo-locale testing,
 * see docs/todos/internationalization.md §7.6). Dev/QA only — never shown
 * in the language dropdown.
 *
 * Device-level QA flag in plain localStorage on purpose: NOT per-user data,
 * so PerAccountLocalStorage would be the wrong tool (same pattern as the
 * update-check flag).
 *
 * Console: `window.__setRtl(true)` / `window.__setRtl(false)` / read state
 * with `window.__setRtl()`. Boot: `?rtl=1` sets the flag, `?rtl=0` clears it.
 * Survives reloads until cleared.
 */
export function setRtlPreview(on?: boolean): boolean {
  if (typeof on === 'boolean') {
    try {
      if (on) localStorage.setItem(RTL_PREVIEW_KEY, '1');
      else localStorage.removeItem(RTL_PREVIEW_KEY);
    } catch {
      // storage unavailable — preview simply won't persist
    }
    if (typeof document !== 'undefined') {
      document.documentElement.dir = effectiveDir(currentLocale);
    }
  }
  return rtlPreviewActive();
}

/** Whether the RTL preview flag is currently set. */
function rtlPreviewActive(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(RTL_PREVIEW_KEY) === '1'
    );
  } catch {
    return false;
  }
}

/**
 * Effective text direction: `dirFor(locale)`, overridden to `'rtl'` while
 * the RTL preview flag is set. The optional second parameter exists for
 * tests (explicit flag wins over storage).
 */
export function effectiveDir(
  locale: string,
  rtlPreview?: boolean
): 'ltr' | 'rtl' {
  if (rtlPreview ?? rtlPreviewActive()) return 'rtl';
  return dirFor(locale);
}

/** `?rtl=1` enables the RTL preview flag, `?rtl=0` clears it. */
function applyRtlBootParam(): void {
  if (typeof location === 'undefined') return;
  const param = new URLSearchParams(location.search).get('rtl');
  if (param === '1') setRtlPreview(true);
  else if (param === '0') setRtlPreview(false);
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
    document.documentElement.dir = effectiveDir(locale);
  }
}

/**
 * Async bootstrap: resolve the stored/system locale, load its catalog if
 * needed, apply html lang/dir. Re-runs on `user:login` (per-account setting).
 */
export async function initI18n(): Promise<void> {
  applyRtlBootParam();
  await applyStoredLocale();

  if (!initialized) {
    initialized = true;
    // Dev/QA helper — see setRtlPreview().
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__setRtl = setRtlPreview;
      // Translation workbench (WP13): type "i18n" outside form fields to
      // load a .po file into the running app (session-only preview).
      const { registerI18nPreviewTrigger } = await import(
        './translationPreview'
      );
      registerI18nPreviewTrigger();
    }
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
  // No system-locale auto-detection: without an explicit user choice the UI
  // stays English. Auto-detecting `navigator.language` would switch existing
  // users to German (or any other registered language) the moment this
  // version ships — never do that. A language question belongs in onboarding
  // (WP12), where the user answers explicitly.
  return stored ? normalizeLocale(stored) : 'en';
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
