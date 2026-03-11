/**
 * Marketplace Add-On — Feature Flags
 *
 * Single switch to enable/disable the entire marketplace feature.
 * When disabled: no sidebar entry, no routes, no code loaded.
 *
 * Timeline integration: periodic listing injection into main timeline.
 */

const FLAG_KEY = 'noornote_marketplace_enabled';
const TIMELINE_ENABLED_KEY = 'noornote_marketplace_timeline_enabled';
const TIMELINE_FREQUENCY_KEY = 'noornote_marketplace_timeline_frequency';

export type ListingFrequency = 'rare' | 'moderate' | 'frequent';

/** Interval in ms for each frequency level */
export const FREQUENCY_INTERVALS: Record<ListingFrequency, number> = {
  rare: 60 * 60 * 1000,      // 60 minutes
  moderate: 30 * 60 * 1000,  // 30 minutes
  frequent: 15 * 60 * 1000,  // 15 minutes
};

/** Dev-only: 60-second interval for testing */
export const DEV_FREQUENCY_INTERVAL = 60 * 1000;

export function isMarketplaceEnabled(): boolean {
  return localStorage.getItem(FLAG_KEY) === 'true';
}

export function setMarketplaceEnabled(enabled: boolean): void {
  localStorage.setItem(FLAG_KEY, enabled.toString());
}

export function isTimelineListingsEnabled(): boolean {
  return localStorage.getItem(TIMELINE_ENABLED_KEY) === 'true';
}

export function setTimelineListingsEnabled(enabled: boolean): void {
  localStorage.setItem(TIMELINE_ENABLED_KEY, enabled.toString());
}

export function getTimelineListingFrequency(): ListingFrequency {
  const stored = localStorage.getItem(TIMELINE_FREQUENCY_KEY);
  if (stored === 'rare' || stored === 'moderate' || stored === 'frequent') return stored;
  return 'rare';
}

export function setTimelineListingFrequency(frequency: ListingFrequency): void {
  localStorage.setItem(TIMELINE_FREQUENCY_KEY, frequency);
}
