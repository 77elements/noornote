/**
 * getActiveTimes - today's prayer times for the active source, shared by the reminder
 * scheduler and the sidebar widget. Diyanet → persistent cache (null if not cached);
 * calculation method → computed locally. Returns null when no usable location/times.
 *
 * getUpcomingDays() returns several days ahead (Diyanet cache rows / day-by-day calc) for
 * the native scheduler, which must enqueue future prayer instants in one go (S4).
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

/** A calendar day plus its prayer times (used to build absolute notification instants). */
export interface DatedPrayerTimes {
  year: number;
  month: number; // 0-based (Date convention)
  day: number;
  times: DayPrayerTimes;
}

/** Parse "HH:MM" into minutes-of-day, or null if malformed. Shared across reminder/widget/scheduler. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
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

/**
 * The active source's Diyanet district id, or null when the source is a calc method or no
 * location is set. Calc sources need no fetch (computed on-device); only Diyanet can run out
 * (rolling ~30-day window) and is re-fetchable. Used by the widget's "Fetch times again" link.
 */
export function activeDiyanetIlceId(): string | null {
  const s = getNostrMajlisSettings();
  return s.source === 'diyanet' && s.diyanetLocation
    ? s.diyanetLocation.ilceId
    : null;
}

/**
 * The next `days` calendar days (starting today) with their prayer times. Diyanet entries are
 * drawn from the persistent cache (only days actually cached are included); calculation sources
 * compute each day locally. Times are device-local (city = where the user is, the normal case).
 */
export function getUpcomingDays(days: number): DatedPrayerTimes[] {
  const s = getNostrMajlisSettings();
  const out: DatedPrayerTimes[] = [];
  const base = new Date();

  if (s.source === 'diyanet') {
    if (!s.diyanetLocation) return out;
    const rows = DiyanetService.getInstance().cachedRows(
      s.diyanetLocation.ilceId
    );
    const byDate = new Map(rows.map(r => [r.date, r]));
    for (let i = 0; i < days; i++) {
      const dt = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate() + i
      );
      const key = `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}`;
      const row = byDate.get(key);
      if (row)
        out.push({
          year: dt.getFullYear(),
          month: dt.getMonth(),
          day: dt.getDate(),
          times: row,
        });
    }
    return out;
  }

  if (isCalcMethod(s.source) && s.calcCity) {
    for (let i = 0; i < days; i++) {
      const dt = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate() + i
      );
      out.push({
        year: dt.getFullYear(),
        month: dt.getMonth(),
        day: dt.getDate(),
        times: computeTimes(s.calcCity, s.source, s.madhab, dt),
      });
    }
    return out;
  }

  return out;
}
