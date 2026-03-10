const STORAGE_KEY = 'noornote_list_settings_enabled';

export function isListSettingsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setListSettingsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
