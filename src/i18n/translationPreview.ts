/**
 * Session translation preview (WP13 workbench) — lets a translator load a
 * .po file into the RUNNING app to see their strings in the real UI, both
 * translated and not-yet-translated (English fallback) ones.
 *
 * Session-only by design: the po text lives in sessionStorage (never in
 * persistent storage) and dies with the app session. Applied via a reload:
 * views (Timeline/Profile are cached singletons that survive navigation)
 * and the boot-rendered sidebar cannot be re-rendered in place, so the
 * preview is injected at boot in initI18n() — before anything renders.
 * Trigger: type "i18n" anywhere outside form fields. Desktop + Web only.
 */
import { applyLocaleState } from './index';
import { PlatformService } from '../services/PlatformService';
import { parsePo } from './poParser';

const TRIGGER_WORD = 'i18n';
const PREVIEW_KEY = 'noornote_i18n_preview_po';

/** Store the po for the rest of this session (applied on next boot). */
export function storePoPreview(poText: string): void {
  sessionStorage.setItem(PREVIEW_KEY, poText);
}

/** Remove the session preview (next boot uses the stored language again). */
export function clearPoPreview(): void {
  sessionStorage.removeItem(PREVIEW_KEY);
}

/** True while a session preview po is stored. */
export function isPoPreviewActive(): boolean {
  return sessionStorage.getItem(PREVIEW_KEY) !== null;
}

/**
 * Boot-time hook (called from initI18n, BEFORE anything renders): apply the
 * session preview instead of the stored locale. Returns true when applied.
 */
export function applyPoPreviewAtBoot(): boolean {
  const text = sessionStorage.getItem(PREVIEW_KEY);
  if (!text) return false;
  const parsed = parsePo(text);
  if (parsed.stats.total === 0) {
    sessionStorage.removeItem(PREVIEW_KEY);
    return false;
  }
  // Unregistered languages are fine here — applyLocaleState is deliberately
  // not gated on LANGUAGES (only the Settings dropdown is). dirFor/plural
  // formulas resolve by language family and work for any locale.
  applyLocaleState(parsed.lang ?? 'preview', parsed.catalog);
  return true;
}

/**
 * Register the typed "i18n" trigger. Called once from initI18n().
 * Desktop + Web only — translators never work on the mobile APK, so the
 * keydown listener is not even registered there.
 */
export function registerI18nPreviewTrigger(): void {
  if (PlatformService.getInstance().isMobile) return;

  let buffer = '';
  document.addEventListener('keydown', event => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      buffer = '';
      return;
    }
    if (event.key.length !== 1) return; // modifiers, Enter, arrows …
    buffer = (buffer + event.key.toLowerCase()).slice(-TRIGGER_WORD.length);
    if (buffer !== TRIGGER_WORD) return;
    buffer = '';
    void openTranslationPreviewModal();
  });
}

async function openTranslationPreviewModal(): Promise<void> {
  const { TranslationPreviewModal } = await import(
    '../components/modals/TranslationPreviewModal'
  );
  new TranslationPreviewModal().show();
}
