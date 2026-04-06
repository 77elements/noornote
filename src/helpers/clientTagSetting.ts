/**
 * Client tag opt-in setting.
 * Controls whether NoorNote adds a `client` tag to events it signs.
 * Per-client (not per-user) — stored in plain localStorage.
 * Default: OFF (opt-in).
 */

const KEY = 'noornote_client_tag_enabled';

export function isClientTagEnabled(): boolean {
  return localStorage.getItem(KEY) === 'true';
}

export function setClientTagEnabled(enabled: boolean): void {
  localStorage.setItem(KEY, enabled ? 'true' : 'false');
}
