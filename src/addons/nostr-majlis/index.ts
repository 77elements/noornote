/**
 * nostr-majlis addon - cheap flag + settings accessors (no heavy imports).
 *
 * "Nostr-Majlis" is the Islamic features suite. Module M1 = Salah (prayer times).
 * M2 (holidays) and M3 (community dhikr) follow. See docs/todos/muslims-addon.md.
 *
 * This file must stay lightweight: only PerAccountLocalStorage, no adhan / no UI.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export interface NostrMajlisSettings {
  /** adhan CalculationMethod key, see SalahService.METHOD_FACTORIES. */
  method: string;
  /** Asr shadow ratio: Standard (Shafi/Maliki/Hanbali) vs Hanafi. */
  madhab: 'shafi' | 'hanafi';
}

const DEFAULT_SETTINGS: NostrMajlisSettings = {
  method: 'MuslimWorldLeague',
  madhab: 'shafi',
};

export function isNostrMajlisEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.NOSTR_MAJLIS_ENABLED, false);
}

export function setNostrMajlisEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTR_MAJLIS_ENABLED, enabled);
}

export function getNostrMajlisSettings(): NostrMajlisSettings {
  const stored = PerAccountLocalStorage.getInstance().get<Partial<NostrMajlisSettings>>(
    StorageKeys.NOSTR_MAJLIS_SETTINGS, {}
  );
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function setNostrMajlisSettings(settings: NostrMajlisSettings): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTR_MAJLIS_SETTINGS, settings);
}
