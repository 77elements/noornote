/**
 * Marketplace Add-On — Feature Flags
 *
 * Single switch to enable/disable the entire marketplace feature.
 * When disabled: no sidebar entry, no routes, no code loaded.
 *
 * Timeline integration: periodic listing injection into main timeline.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export type ListingFrequency = 'rare' | 'moderate' | 'frequent' | 'more-frequent' | 'realtime';

/** Interval in ms for each frequency level */
export const FREQUENCY_INTERVALS: Record<ListingFrequency, number> = {
  rare: 60 * 60 * 1000,           // 60 minutes
  moderate: 30 * 60 * 1000,       // 30 minutes
  frequent: 15 * 60 * 1000,       // 15 minutes
  'more-frequent': 5 * 60 * 1000, // 5 minutes
  realtime: 60 * 1000,            // 60 seconds
};

export function isMarketplaceEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.MARKETPLACE_ENABLED, false);
}

export function setMarketplaceEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.MARKETPLACE_ENABLED, enabled);
}

export function isTimelineListingsEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.MARKETPLACE_TIMELINE_ENABLED, false);
}

export function setTimelineListingsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.MARKETPLACE_TIMELINE_ENABLED, enabled);
}

export function getTimelineListingFrequency(): ListingFrequency {
  const stored = PerAccountLocalStorage.getInstance().get<string>(StorageKeys.MARKETPLACE_TIMELINE_FREQUENCY, 'rare');
  if (stored === 'rare' || stored === 'moderate' || stored === 'frequent' || stored === 'more-frequent' || stored === 'realtime') return stored;
  return 'rare';
}

export function setTimelineListingFrequency(frequency: ListingFrequency): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.MARKETPLACE_TIMELINE_FREQUENCY, frequency);
}
