/**
 * NostrMajlisNativeReminders - native prayer/holiday reminders on Capacitor / Android.
 *
 * Thin adapter over the central ReminderHub (the generalization of this very
 * pattern): it registers the two Nostr-Majlis namespaces — prayers and
 * holidays — and rebuilds their specs from domain data on every reschedule.
 * All platform mechanics (permission, scheduling with allowWhileIdle +
 * timeoutAfter, ID-pool cancel, App-Resume handling) live in the hub.
 *
 * Specs (unchanged behavior):
 *   - prayers:  [prayer − offset] for the next few days,
 *   - holidays: N days before each upcoming Islamic holiday.
 * On Capacitor this REPLACES the AlertBar (the OS notification also shows in
 * the foreground), so they don't double up. No-op on Electron / Web (the
 * NostrMajlisReminderService scan handles those platforms).
 *
 * Timezone note: instants are built from device-local time, correct when the
 * chosen city is where the user is (the normal case). A foreign city only
 * shifts reminder timing.
 */

import { TypedEventBus } from '../../core/TypedEventBus';
import { ReminderHub } from '../../services/notifications/ReminderHub';
import {
  isNostrMajlisEnabled,
  getNostrMajlisSettings,
  type ReminderPrayers,
} from './index';
import { getUpcomingDays, parseHHMM } from './activeTimes';
import { getHolidayReminders } from './holidays';
import { formatDateByCalendar } from '../../helpers/formatTimestamp';

const PRAYER_DAYS_AHEAD = 7;
/** Prayer notifications auto-close this many minutes after the prayer time (system-side timeout). */
const PRAYER_LINGER_MIN = 10;
/** Holiday notifications auto-close 3 hours after firing. */
const HOLIDAY_LINGER_MS = 3 * 60 * 60_000;
const PRAYERS: [keyof ReminderPrayers, string][] = [
  ['fajr', 'Fajr'],
  ['dhuhr', 'Dhuhr'],
  ['asr', 'Asr'],
  ['maghrib', 'Maghrib'],
  ['isha', 'Isha'],
];
const PRAYER_ID_BASE = 90_000_000;
const PRAYER_POOL = PRAYER_DAYS_AHEAD * PRAYERS.length; // 35
const HOLIDAY_ID_BASE = 90_001_000;
const HOLIDAY_POOL = 16; // ~a full Hijri year of holidays ahead

export class NostrMajlisNativeReminders {
  private bus = TypedEventBus.getInstance();
  private subId: string | null = null;

  async start(): Promise<void> {
    const hub = ReminderHub.getInstance();

    hub.registerNamespace({
      name: 'majlis-prayer',
      idBase: PRAYER_ID_BASE,
      poolSize: PRAYER_POOL,
      build: () => Promise.resolve(this.buildPrayers()),
    });
    hub.registerNamespace({
      name: 'majlis-holiday',
      idBase: HOLIDAY_ID_BASE,
      poolSize: HOLIDAY_POOL,
      build: () => Promise.resolve(this.buildHolidays()),
    });

    // Settings changes reschedule both pools (the hub debounces bursts).
    this.subId = this.bus.on('nostr-majlis:settings-changed', () => {
      hub.rescheduleSoon('majlis-prayer');
      hub.rescheduleSoon('majlis-holiday');
    });
  }

  private buildPrayers(): import('../../services/notifications/ReminderHub').ReminderSpec[] {
    const specs: import('../../services/notifications/ReminderHub').ReminderSpec[] =
      [];
    if (!isNostrMajlisEnabled()) return specs;
    const s = getNostrMajlisSettings();
    if (!s.reminders?.enabled) return specs;

    const now = Date.now();
    let n = 0;
    for (const day of getUpcomingDays(PRAYER_DAYS_AHEAD)) {
      for (const [key, name] of PRAYERS) {
        if (!s.reminders.prayers[key]) continue;
        const pm = parseHHMM(day.times[key]);
        if (pm === null) continue;
        const at =
          new Date(
            day.year,
            day.month,
            day.day,
            Math.floor(pm / 60),
            pm % 60,
            0
          ).getTime() -
          s.reminders.offsetMin * 60_000;
        if (at <= now) continue;
        if (n >= PRAYER_POOL) return specs;
        specs.push({
          id: PRAYER_ID_BASE + n,
          title: `${name} prayer`,
          body: `In ${s.reminders.offsetMin} min (${day.times[key]})`,
          // timeoutAfter: auto-dismiss at prayer + 10 min, even when the app
          // is closed (NoorNote plugin patch reads extra.timeoutAfter).
          timeoutAfterMs: (s.reminders.offsetMin + PRAYER_LINGER_MIN) * 60_000,
          // allowWhileIdle: time-critical, must fire during Doze.
          allowWhileIdle: true,
          fireAt: at,
        });
        n++;
      }
    }
    return specs;
  }

  private buildHolidays(): import('../../services/notifications/ReminderHub').ReminderSpec[] {
    const specs: import('../../services/notifications/ReminderHub').ReminderSpec[] =
      [];
    if (!isNostrMajlisEnabled()) return specs;
    const s = getNostrMajlisSettings();
    const days = s.holidayReminder.daysBefore;
    let n = 0;
    for (const rem of getHolidayReminders(days)) {
      if (rem.fireAt.getTime() <= Date.now()) continue;
      if (n >= HOLIDAY_POOL) break;
      specs.push({
        id: HOLIDAY_ID_BASE + n,
        title: rem.name,
        body: `In ${days} day${days === 1 ? '' : 's'} (${formatDateByCalendar(rem.date)})`,
        timeoutAfterMs: HOLIDAY_LINGER_MS,
        allowWhileIdle: true,
        fireAt: rem.fireAt.getTime(),
      });
      n++;
    }
    return specs;
  }

  async destroy(): Promise<void> {
    if (this.subId) {
      this.bus.off(this.subId);
      this.subId = null;
    }
    const hub = ReminderHub.getInstance();
    await hub.disposeNamespace('majlis-prayer');
    await hub.disposeNamespace('majlis-holiday');
    diagLogDestroyed();
  }
}

function diagLogDestroyed(): void {
  void import('../../services/DiagnosticLogger')
    .then(m => m.diagLog('addons', 'nostr-majlis: native reminders destroyed'))
    .catch(() => {});
}
