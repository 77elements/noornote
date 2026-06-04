/**
 * SalahService - local prayer-time calculation (paradigm A, sovereignty-clean).
 *
 * Pure on-device calculation via the `adhan` library (batoulapps/adhan-js). No network,
 * no location leak. The `adhan` import lives here (and is pulled into the addon's lazy
 * chunk), never into the main bundle.
 *
 * S1 scope: compute today's times for a HARDCODED test location. The cascading
 * Country -> Region -> City picker (GeoNames) and real coords/timezone land in S2.
 * Background reminder scheduling (AlertBar + native notifications) lands in S3/S4.
 *
 * See docs/todos/muslims-addon.md.
 */

import { CalculationMethod, type CalculationParameters, Coordinates, Madhab, PrayerTimes } from 'adhan';
import { getNostrMajlisSettings } from './index';
import { diagLog } from '../../services/DiagnosticLogger';

/** S1 placeholder location until the GeoNames city picker (S2) provides real coords. */
const TEST_LOCATION = {
  label: 'Mecca — test location (city picker arrives in S2)',
  latitude: 21.4225,
  longitude: 39.8262,
};

export interface PrayerTime {
  name: string;
  time: Date;
}

/** adhan calculation methods exposed in the UI (Fajr/Isha twilight angles differ). */
export const METHOD_FACTORIES: Record<string, () => CalculationParameters> = {
  MuslimWorldLeague: () => CalculationMethod.MuslimWorldLeague(),
  Turkey: () => CalculationMethod.Turkey(),
  NorthAmerica: () => CalculationMethod.NorthAmerica(),
  Egyptian: () => CalculationMethod.Egyptian(),
  UmmAlQura: () => CalculationMethod.UmmAlQura(),
  Karachi: () => CalculationMethod.Karachi(),
  Tehran: () => CalculationMethod.Tehran(),
  Dubai: () => CalculationMethod.Dubai(),
  Kuwait: () => CalculationMethod.Kuwait(),
  Qatar: () => CalculationMethod.Qatar(),
  Singapore: () => CalculationMethod.Singapore(),
  MoonsightingCommittee: () => CalculationMethod.MoonsightingCommittee(),
};

export class SalahService {
  private static instance: SalahService | null = null;

  static getInstance(): SalahService {
    if (!SalahService.instance) SalahService.instance = new SalahService();
    return SalahService.instance;
  }

  get location(): typeof TEST_LOCATION {
    return TEST_LOCATION;
  }

  /** Compute the day's prayer times for the configured method/madhab and test location. */
  computeTimes(date: Date = new Date()): PrayerTime[] {
    const settings = getNostrMajlisSettings();
    const factory = METHOD_FACTORIES[settings.method] ?? (() => CalculationMethod.MuslimWorldLeague());
    const params = factory();
    params.madhab = settings.madhab === 'hanafi' ? Madhab.Hanafi : Madhab.Shafi;

    const coords = new Coordinates(TEST_LOCATION.latitude, TEST_LOCATION.longitude);
    const pt = new PrayerTimes(coords, date, params);

    return [
      { name: 'Fajr', time: pt.fajr },
      { name: 'Sunrise', time: pt.sunrise },
      { name: 'Dhuhr', time: pt.dhuhr },
      { name: 'Asr', time: pt.asr },
      { name: 'Maghrib', time: pt.maghrib },
      { name: 'Isha', time: pt.isha },
    ];
  }

  /** AddonLoader destroy contract: null the singleton so account-switch gets a fresh one. */
  destroy(): void {
    SalahService.instance = null;
    diagLog('addons', 'nostr-majlis: SalahService destroyed');
  }
}
