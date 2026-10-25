/**
 * Session translation preview (WP13 workbench) — lets a translator load a
 * .po file into the RUNNING app to see their strings in the real UI, both
 * translated and not-yet-translated (English fallback) ones.
 *
 * Session-only by design: nothing is persisted, a reload resets to the
 * stored per-account locale. Trigger: type "i18n" anywhere outside form
 * fields (same concept as the old nip51 inspector helper).
 */
import { applyLocaleState } from './index';
import { PlatformService } from '../services/PlatformService';
import type { PoParseResult } from './poParser';

const TRIGGER_WORD = 'i18n';

/** Apply a parsed po as the UI catalog for this session (no persistence). */
export function applyPreview(parsed: PoParseResult): void {
  // Unregistered languages are fine here — applyLocaleState is deliberately
  // not gated on LANGUAGES (only the Settings dropdown is). dirFor/plural
  // formulas resolve by language family and work for any locale.
  applyLocaleState(parsed.lang ?? 'preview', parsed.catalog);
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
