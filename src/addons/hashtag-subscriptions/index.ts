const STORAGE_KEY = 'noornote_hashtag_subscriptions_enabled';

export function isHashtagSubscriptionsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setHashtagSubscriptionsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
