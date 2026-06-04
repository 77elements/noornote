/**
 * getActiveTimes - today's prayer times for the active source, shared by the reminder
 * scheduler and the sidebar widget. Diyanet → persistent cache (null if not cached);
 * calculation method → computed locally. Returns null when no usable location/times.
 */

import { getNostrMajlisSettings } from './index';
import { DiyanetService } from './DiyanetService';
import { computeTimes, isCalcMethod } from './SalahService';

export interface DayPrayerTimes {
  fajr: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
  sunrise?: string;
}

export function getActiveTimes(): DayPrayerTimes | null {
  const s = getNostrMajlisSettings();
  if (s.source === 'diyanet') {
    if (!s.diyanetLocation) return null;
    return DiyanetService.getInstance().cachedToday(s.diyanetLocation.ilceId);
  }
  if (isCalcMethod(s.source) && s.calcCity) {
    return computeTimes(s.calcCity, s.source, s.madhab);
  }
  return null;
}
