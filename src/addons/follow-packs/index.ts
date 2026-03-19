const STORAGE_KEY = 'noornote_follow_packs_enabled';

export function isFollowPacksEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setFollowPacksEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
