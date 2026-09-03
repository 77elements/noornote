/**
 * Global (account-independent) localStorage keys used across multiple files.
 *
 * Deliberately NOT in PerAccountLocalStorage.StorageKeys — these keys must
 * stay identical across accounts (auth state, app-wide settings). Per-file
 * single-owner keys (noornote_theme, noornote_update_*, …) stay as literals
 * next to their owning service.
 */

/** Auth-state flag: "some key exists on this device" (Router, auth UI). */
export const GLOBAL_KEY_HAS_KEY = 'noornote_has_key';
