/**
 * Marketplace Add-On — Feature Flag
 *
 * Single switch to enable/disable the entire marketplace feature.
 * When disabled: no sidebar entry, no routes, no code loaded.
 */

const FLAG_KEY = 'noornote_marketplace_enabled';

export function isMarketplaceEnabled(): boolean {
  return localStorage.getItem(FLAG_KEY) === 'true';
}

export function setMarketplaceEnabled(enabled: boolean): void {
  localStorage.setItem(FLAG_KEY, enabled.toString());
}
