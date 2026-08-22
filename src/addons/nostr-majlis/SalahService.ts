/**
 * SalahService - local prayer-time calculation via adhan (the calculation sources).
 *
 * Stateless: computes times from a GeoNames city's coordinates for a chosen calculation
 * method + Asr madhab, formatted in the city's timezone. The Diyanet source does NOT use
 * this (it uses official fetched data). adhan is imported here (addon's lazy chunk only).
 * Pure calc cannot reproduce authority-published times at high latitudes — see docs.
 */

import {
  CalculationMethod,
  type CalculationParameters,
  Coordinates,
  HighLatitudeRule,
  Madhab,
  PrayerTimes,
} from 'adhan';
import type { CalcCity } from './index';

export interface ComputedTimes {
  fajr: string;
  sunrise: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
}

/** Calculation-method source keys (Fajr/Isha twilight angles differ). */
export const CALC_METHODS: { value: string; label: string }[] = [
  { value: 'MuslimWorldLeague', label: 'Muslim World League' },
  { value: 'NorthAmerica', label: 'ISNA (North America)' },
  { value: 'Egyptian', label: 'Egyptian General Authority' },
  { value: 'UmmAlQura', label: 'Umm al-Qura (Makkah)' },
  { value: 'Karachi', label: 'Karachi' },
  { value: 'Tehran', label: 'Tehran (Jafari)' },
  { value: 'Dubai', label: 'Dubai' },
  { value: 'Kuwait', label: 'Kuwait' },
  { value: 'Qatar', label: 'Qatar' },
  { value: 'Singapore', label: 'Singapore (MUIS)' },
  { value: 'MoonsightingCommittee', label: 'Moonsighting Committee' },
];

const FACTORIES: Record<string, () => CalculationParameters> = {
  MuslimWorldLeague: () => CalculationMethod.MuslimWorldLeague(),
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

export function isCalcMethod(source: string): boolean {
  return source in FACTORIES;
}

export function computeTimes(
  city: CalcCity,
  method: string,
  madhab: 'shafi' | 'hanafi',
  date: Date = new Date()
): ComputedTimes {
  const factory =
    FACTORIES[method] ?? (() => CalculationMethod.MuslimWorldLeague());
  const params = factory();
  params.madhab = madhab === 'hanafi' ? Madhab.Hanafi : Madhab.Shafi;
  const coords = new Coordinates(city.lat, city.lng);
  // High-latitude twilight handling (else Fajr/Isha collapse to mid-night near solstice).
  params.highLatitudeRule = HighLatitudeRule.recommended(coords);

  const pt = new PrayerTimes(coords, date, params);
  const fmt = new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: city.tz,
  });
  return {
    fajr: fmt.format(pt.fajr),
    sunrise: fmt.format(pt.sunrise),
    dhuhr: fmt.format(pt.dhuhr),
    asr: fmt.format(pt.asr),
    maghrib: fmt.format(pt.maghrib),
    isha: fmt.format(pt.isha),
  };
}
