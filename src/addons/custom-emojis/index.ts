/**
 * Custom Emojis Addon — lightweight entry
 *
 * Heavy code (EmojiService, picker, settings UI) lives in sibling files
 * and must be loaded via dynamic `import()` only when the addon is enabled.
 *
 * NOTE: Only the *use* of custom emojis (own pack management + editor picker
 * + publish-side tagging) is gated by this flag. Rendering of other users'
 * custom emojis is core and always active (see src/helpers/formatCustomEmojis.ts).
 */

import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_custom_emojis_enabled';

export function isCustomEmojisEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.CUSTOM_EMOJIS_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setCustomEmojisEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.CUSTOM_EMOJIS_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
