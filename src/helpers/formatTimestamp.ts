/**
 * Format timestamp to human readable format with .date-time CSS class
 *
 * Rules:
 * 1. Within last hour: "12m" or "34s"
 * 2. Older than 1 hour but same calendar day: "20:43"
 * 3. Older than today but current calendar year: "30. Oct, 20:43"
 * 4. Older than current calendar year: "30. Oct. 2024, 20:43"
 *
 * Calendar System Support:
 * - Gregorian: Standard Western calendar (default)
 * - Hijri: Islamic calendar (Umm al-Qura)
 * - Both: Display both calendars side-by-side
 *
 * @param timestamp - Unix timestamp in seconds
 * @returns HTML string with formatted time wrapped in span.date-time
 */

import dayjs from 'dayjs';
import calendarSystems from '@calidy/dayjs-calendarsystems';
import HijriCalendarSystem from '@calidy/dayjs-calendarsystems/calendarSystems/HijriCalendarSystem';
import { PerAccountLocalStorage, StorageKeys } from '../services/PerAccountLocalStorage';

// Initialize dayjs with calendar systems plugin
dayjs.extend(calendarSystems);
dayjs.registerCalendarSystem('hijri', new HijriCalendarSystem());

type CalendarSystem = 'gregorian' | 'hijri' | 'both';

/**
 * Hijri month names (English transliteration)
 */
const HIJRI_MONTHS = [
  'Muharram',
  'Safar',
  "Rabi' al-Awwal",
  "Rabi' ath-Thani",
  'Jumada al-Ula',
  'Jumada al-Akhirah',
  'Rajab',
  "Sha'ban",
  'Ramadan',
  'Shawwal',
  "Dhu al-Qi'dah",
  'Dhu al-Hijjah',
];

export function formatTimestamp(timestamp: number): string {
  if (!timestamp) return '';

  const now = new Date();
  const date = new Date(timestamp * 1000);
  const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  let formatted: string;

  // Rule 1: Within last hour (relative time, no calendar needed)
  if (diffSeconds < 3600) {
    if (diffSeconds < 60) {
      formatted = `${Math.max(1, diffSeconds)}s`;
    } else {
      formatted = `${Math.floor(diffSeconds / 60)}m`;
    }
  } else {
    const calendarSystem = getCalendarSystem();
    const time = formatTime(date);

    // Rule 2: Same calendar day (time-only, no calendar needed)
    if (isSameDay(date, now, calendarSystem)) {
      formatted = time;
    } else {
      // Rule 3 & 4: Absolute dates (calendar-aware)
      const includeYear = !isSameYear(date, now, calendarSystem);
      formatted = formatAbsoluteDate(date, now, time, includeYear, calendarSystem);
    }
  }

  return `<span class="date-time">${formatted}</span>`;
}

/**
 * Get user's calendar system preference
 */
function getCalendarSystem(): CalendarSystem {
  try {
    const storage = PerAccountLocalStorage.getInstance();
    return storage.get<CalendarSystem>(StorageKeys.CALENDAR_SYSTEM, 'gregorian');
  } catch {
    return 'gregorian';
  }
}

/**
 * Format absolute date based on calendar system
 */
function formatAbsoluteDate(
  date: Date,
  now: Date,
  time: string,
  includeYear: boolean,
  calendarSystem: CalendarSystem
): string {
  switch (calendarSystem) {
    case 'gregorian':
      return formatGregorianDate(date, time, includeYear);
    case 'hijri':
      return formatHijriDate(date, time, includeYear);
    case 'both':
      return formatBothDates(date, time, includeYear);
    default:
      return formatGregorianDate(date, time, includeYear);
  }
}

/**
 * Format Gregorian date (existing logic)
 */
function formatGregorianDate(date: Date, time: string, includeYear: boolean): string {
  const day = date.getDate();
  const month = getMonthShort(date);

  if (includeYear) {
    return `${day}. ${month}. ${date.getFullYear()}, ${time}`;
  } else {
    return `${day}. ${month}, ${time}`;
  }
}

/**
 * Format Hijri date using Day.js calendar plugin
 */
function formatHijriDate(date: Date, time: string, includeYear: boolean): string {
  const hijriDate = dayjs(date).toCalendarSystem('hijri');
  const day = hijriDate.date();
  const month = HIJRI_MONTHS[hijriDate.month()];
  const year = hijriDate.year();

  if (includeYear) {
    return `${day}. ${month} ${year}, ${time}`;
  } else {
    return `${day}. ${month}, ${time}`;
  }
}

/**
 * Format both Gregorian and Hijri dates side-by-side
 */
function formatBothDates(date: Date, time: string, includeYear: boolean): string {
  const gregorianDay = date.getDate();
  const gregorianMonth = getMonthShort(date);
  const gregorianYear = date.getFullYear();

  const hijriDate = dayjs(date).toCalendarSystem('hijri');
  const hijriDay = hijriDate.date();
  const hijriMonth = HIJRI_MONTHS[hijriDate.month()];
  const hijriYear = hijriDate.year();

  let formatted = '';

  if (includeYear) {
    formatted = `${gregorianDay}. ${gregorianMonth}. ${gregorianYear}, ${time} (${hijriDay}. ${hijriMonth} ${hijriYear})`;
  } else {
    formatted = `${gregorianDay}. ${gregorianMonth}, ${time} (${hijriDay}. ${hijriMonth})`;
  }

  return formatted;
}

/**
 * Format time as HH:MM with fallback for Intl.DateTimeFormat errors
 */
function formatTime(date: Date): string {
  try {
    return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch {
    // Fallback: Manual formatting if Intl is unavailable
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
}

/**
 * Get short month name with fallback for Intl.DateTimeFormat errors
 */
function getMonthShort(date: Date): string {
  try {
    return date.toLocaleString('en-US', { month: 'short' });
  } catch {
    // Fallback: Manual month names if Intl is unavailable
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[date.getMonth()];
  }
}

/**
 * Check if two dates are the same calendar day (calendar-aware)
 */
function isSameDay(date1: Date, date2: Date, calendarSystem: CalendarSystem): boolean {
  // For Gregorian and 'both' mode, use Gregorian comparison
  if (calendarSystem === 'gregorian' || calendarSystem === 'both') {
    return (
      date1.getFullYear() === date2.getFullYear() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getDate() === date2.getDate()
    );
  }

  // For Hijri mode, use Islamic calendar comparison
  if (calendarSystem === 'hijri') {
    const hijri1 = dayjs(date1).toCalendarSystem('hijri');
    const hijri2 = dayjs(date2).toCalendarSystem('hijri');
    return (
      hijri1.year() === hijri2.year() &&
      hijri1.month() === hijri2.month() &&
      hijri1.date() === hijri2.date()
    );
  }

  return false;
}

/**
 * Check if two dates are in the same calendar year (calendar-aware)
 */
function isSameYear(date1: Date, date2: Date, calendarSystem: CalendarSystem): boolean {
  // For Gregorian and 'both' mode, use Gregorian comparison
  if (calendarSystem === 'gregorian' || calendarSystem === 'both') {
    return date1.getFullYear() === date2.getFullYear();
  }

  // For Hijri mode, use Islamic calendar comparison
  if (calendarSystem === 'hijri') {
    const hijri1 = dayjs(date1).toCalendarSystem('hijri');
    const hijri2 = dayjs(date2).toCalendarSystem('hijri');
    return hijri1.year() === hijri2.year();
  }

  return false;
}
