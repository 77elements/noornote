/**
 * Islamic holidays (M2) - computed locally, zero network.
 *
 * Each holiday sits on a FIXED Hijri date. We use the same Umm al-Qura Hijri calendar already
 * wired across the app (@calidy/dayjs-calendarsystems) to convert those fixed Hijri dates to
 * Gregorian for any year. Umm al-Qura is itself calculated, so local moon-sighting committees
 * can still differ by ±1 day (especially Ramadan / Eid) — the UI labels these as calculated.
 */

import dayjs from 'dayjs';
import calendarSystems from '@calidy/dayjs-calendarsystems';
import HijriCalendarSystem from '@calidy/dayjs-calendarsystems/calendarSystems/HijriCalendarSystem';

// Match the app-wide registration (idempotent; MainLayout / ProfileView / formatTimestamp do the same).
dayjs.extend(calendarSystems);
dayjs.registerCalendarSystem('hijri' as any, new HijriCalendarSystem());

// We call convertToGregorian() directly: dayjs.fromCalendarSystem() has a month off-by-one
// (it stringifies a 0-based month that dayjs then reads as 1-based). The calendar instance's
// own conversion is correct (verified against the known Ramadan/Eid dates).
const hijriCalendar = new HijriCalendarSystem();

export interface Holiday {
  key: string;
  name: string;
  /** Hijri month, 0-based (0 = Muharram). */
  hMonth: number;
  /** Hijri day of month. */
  hDay: number;
}

/** The fixed-date holidays, in Hijri-calendar order. */
export const HOLIDAYS: Holiday[] = [
  { key: 'new-year', name: 'Islamic New Year', hMonth: 0, hDay: 1 },
  { key: 'ashura', name: 'Ashura', hMonth: 0, hDay: 10 },
  { key: 'mawlid', name: 'Mawlid al-Nabi', hMonth: 2, hDay: 12 },
  { key: 'isra-miraj', name: "Isra' & Mi'raj", hMonth: 6, hDay: 27 },
  { key: 'mid-shaban', name: "Mid-Sha'ban", hMonth: 7, hDay: 15 },
  { key: 'ramadan', name: 'Ramadan begins', hMonth: 8, hDay: 1 },
  { key: 'laylat-al-qadr', name: 'Laylat al-Qadr', hMonth: 8, hDay: 27 },
  { key: 'eid-al-fitr', name: 'Eid al-Fitr', hMonth: 9, hDay: 1 },
  { key: 'arafah', name: 'Day of Arafah', hMonth: 11, hDay: 9 },
  { key: 'eid-al-adha', name: 'Eid al-Adha', hMonth: 11, hDay: 10 },
];

export interface HolidayOccurrence {
  key: string;
  name: string;
  /** Gregorian date (local midnight) the holiday begins. */
  date: Date;
}

/** Convert one fixed Hijri date in a given Hijri year to its Gregorian Date (local midnight). */
function toGregorian(hYear: number, hMonth: number, hDay: number): Date {
  const g = hijriCalendar.convertToGregorian(hYear, hMonth, hDay) as { year: number; month: number; day: number };
  return new Date(g.year, g.month, g.day);
}

/**
 * All holiday occurrences whose Gregorian date falls within the given Gregorian year, sorted
 * by date. The Hijri year is ~11 days shorter, so a Gregorian year overlaps up to three Hijri
 * years — we scan that range, which naturally yields the rare double (or zero) occurrence of a
 * holiday within one Gregorian year.
 */
export function getHolidaysForGregorianYear(gYear: number): HolidayOccurrence[] {
  const hStart = dayjs(new Date(gYear, 0, 1)).toCalendarSystem('hijri' as any).year();
  const hEnd = dayjs(new Date(gYear, 11, 31)).toCalendarSystem('hijri' as any).year();

  const out: HolidayOccurrence[] = [];
  for (let hy = hStart - 1; hy <= hEnd + 1; hy++) {
    for (const h of HOLIDAYS) {
      const date = toGregorian(hy, h.hMonth, h.hDay);
      if (date.getFullYear() === gYear) out.push({ key: h.key, name: h.name, date });
    }
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

/** Local hour at which a holiday reminder fires on its reminder day. */
export const HOLIDAY_REMINDER_HOUR = 9;

export interface HolidayReminder extends HolidayOccurrence {
  /** When the reminder fires: 09:00 local, `daysBefore` days before the holiday. */
  fireAt: Date;
}

/**
 * Holiday reminders across this and the next two Gregorian years (covers a full Hijri cycle),
 * each with its fire instant. Consumers filter: the native scheduler takes future ones to
 * enqueue, the in-app poll takes the one due today.
 */
export function getHolidayReminders(daysBefore: number): HolidayReminder[] {
  const y = new Date().getFullYear();
  const out: HolidayReminder[] = [];
  for (let yr = y; yr <= y + 2; yr++) {
    for (const h of getHolidaysForGregorianYear(yr)) {
      const fireAt = new Date(h.date.getFullYear(), h.date.getMonth(), h.date.getDate() - daysBefore, HOLIDAY_REMINDER_HOUR, 0, 0);
      out.push({ ...h, fireAt });
    }
  }
  out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  return out;
}
