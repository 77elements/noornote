/**
 * nostr-majlis addon - cheap flag + settings accessors (no heavy imports).
 *
 * "Nostr-Majlis" is the Islamic features suite. Module M1 = Salah (prayer times).
 * M2 (holidays) and M3 (community dhikr) follow. See docs/todos/muslims-addon.md.
 *
 * Two prayer-time source kinds:
 *  - 'diyanet' = official Diyanet times, fetched at runtime (exact, worldwide, online).
 *  - a calculation method key (MuslimWorldLeague, Turkey, …) = computed locally via adhan
 *    from a GeoNames city's coordinates (offline, worldwide, approximate).
 *
 * The addon is opt-in; enabling it + picking a city is the consented data flow (§5).
 * This file stays lightweight: only PerAccountLocalStorage, no network / adhan / UI / dataset.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { TypedEventBus } from '../../core/TypedEventBus';

/** A location in Diyanet's own hierarchy (Country -> Region -> District). */
export interface DiyanetLocation {
  ulkeId: string;
  sehirId: string;
  ilceId: string;
  label: string;
}

/** A GeoNames city used by the calculation sources (coords + timezone, on-device). */
export interface CalcCity {
  name: string;
  cc: string;
  a1: string;
  lat: number;
  lng: number;
  tz: string;
  label: string;
}

/** Which of the five obligatory prayers fire an in-app reminder. */
export interface ReminderPrayers {
  fajr: boolean;
  dhuhr: boolean;
  asr: boolean;
  maghrib: boolean;
  isha: boolean;
}

export interface ReminderSettings {
  enabled: boolean;
  /** Minutes before each prayer the reminder fires. */
  offsetMin: number;
  prayers: ReminderPrayers;
}

/** Reminders for Islamic holidays (M2), fired at 09:00 local on the day N days before. */
export interface HolidayReminderSettings {
  enabled: boolean;
  /** Days before the holiday the reminder fires (1 / 3 / 7 / 10). */
  daysBefore: number;
}

export interface NostrMajlisSettings {
  /** 'diyanet' (official API) or an adhan calculation-method key. */
  source: string;
  /** Asr shadow ratio for calculation sources. */
  madhab: 'shafi' | 'hanafi';
  /** Location for the Diyanet source. */
  diyanetLocation: DiyanetLocation | null;
  /** Location for the calculation sources. */
  calcCity: CalcCity | null;
  /** In-app prayer reminders (AlertBar) while the app is open. */
  reminders: ReminderSettings;
  /** Reminders for Islamic holidays (M2). */
  holidayReminder: HolidayReminderSettings;
  /** Show the current-prayer / countdown widget in the sidebar. */
  sidebarWidget: boolean;
  /** In-app notifications on community-dhikr activity (new rounds, big commits, completion). */
  dhikrNotifications: boolean;
}

const DEFAULT_SETTINGS: NostrMajlisSettings = {
  source: 'diyanet',
  madhab: 'shafi',
  diyanetLocation: null,
  calcCity: null,
  reminders: {
    enabled: true,
    offsetMin: 10,
    prayers: { fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true },
  },
  holidayReminder: { enabled: false, daysBefore: 3 },
  sidebarWidget: false,
  dhikrNotifications: true,
};

export function isNostrMajlisEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.NOSTR_MAJLIS_ENABLED,
    false
  );
}

export function setNostrMajlisEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.NOSTR_MAJLIS_ENABLED,
    enabled
  );
}

export function getNostrMajlisSettings(): NostrMajlisSettings {
  const stored = PerAccountLocalStorage.getInstance().get<
    Partial<NostrMajlisSettings>
  >(StorageKeys.NOSTR_MAJLIS_SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function setNostrMajlisSettings(settings: NostrMajlisSettings): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.NOSTR_MAJLIS_SETTINGS,
    settings
  );
  // Let the native scheduler re-enqueue alarms after any source/location/reminder change.
  TypedEventBus.getInstance().emit('nostr-majlis:settings-changed');
}
