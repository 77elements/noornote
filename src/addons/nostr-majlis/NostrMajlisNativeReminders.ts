/**
 * NostrMajlisNativeReminders - native scheduled reminders (Capacitor / Android).
 *
 * Unlike the in-app AlertBar (NostrMajlisReminderService), these fire even when the app is
 * closed or the phone is asleep: it schedules OS-level local notifications via
 * @capacitor/local-notifications. Two kinds:
 *   - prayers:  [prayer − offset] for the next few days,
 *   - holidays: 09:00 local, N days before each upcoming Islamic holiday.
 * On Capacitor this REPLACES the AlertBar (the OS notification also shows in the foreground),
 * so they don't double up.
 *
 * Rescheduling: on start, on every settings change (nostr-majlis:settings-changed) and on app
 * resume (date rollover / new times fetched). Owned by the addon runtime — destroy() removes the
 * listeners and cancels all pending notifications, so nothing leaks across logout / toggle-off.
 *
 * Timezone note: instants are built from device-local time, correct when the chosen city is
 * where the user is (the normal case). A foreign city only shifts reminder timing.
 *
 * No-op on Electron / Web (handled separately by the running-app Notification path).
 */

import { PlatformService } from '../../services/PlatformService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { diagLog } from '../../services/DiagnosticLogger';
import { isNostrMajlisEnabled, getNostrMajlisSettings, type ReminderPrayers } from './index';
import { getUpcomingDays, parseHHMM } from './activeTimes';
import { getHolidayReminders } from './holidays';
import { formatDateByCalendar } from '../../helpers/formatTimestamp';

// Dedicated id ranges so we can cancel exactly our own notifications without touching others.
const PRAYER_DAYS_AHEAD = 7;
const PRAYERS: [keyof ReminderPrayers, string][] = [
  ['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
];
const PRAYER_ID_BASE = 90_000_000;
const PRAYER_POOL = PRAYER_DAYS_AHEAD * PRAYERS.length; // 35
const HOLIDAY_ID_BASE = 90_001_000;
const HOLIDAY_POOL = 16; // ~a full Hijri year of holidays ahead

const ID_POOL = [
  ...Array.from({ length: PRAYER_POOL }, (_, i) => ({ id: PRAYER_ID_BASE + i })),
  ...Array.from({ length: HOLIDAY_POOL }, (_, i) => ({ id: HOLIDAY_ID_BASE + i })),
];
const RESCHEDULE_DEBOUNCE_MS = 600;

interface NotificationSpec { id: number; title: string; body: string; schedule: { at: Date; allowWhileIdle: boolean }; }

/** Minimal Capacitor PluginListenerHandle shape (avoids importing the type into core paths). */
interface ListenerHandle { remove: () => Promise<void>; }

export class NostrMajlisNativeReminders {
  private bus = TypedEventBus.getInstance();
  private subId: string | null = null;
  private resumeHandle: ListenerHandle | null = null;
  private debounce: number | null = null;

  async start(): Promise<void> {
    if (!PlatformService.getInstance().isCapacitor) return;

    this.subId = this.bus.on('nostr-majlis:settings-changed', () => this.scheduleSoon());
    const { App } = await import('@capacitor/app');
    this.resumeHandle = await App.addListener('resume', () => this.scheduleSoon());

    await this.reschedule();
  }

  /** Debounced reschedule (settings often change in bursts as the user edits the form). */
  private scheduleSoon(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => { this.debounce = null; void this.reschedule(); }, RESCHEDULE_DEBOUNCE_MS);
  }

  /** Cancel our pending notifications and enqueue the next window from scratch. */
  private async reschedule(): Promise<void> {
    if (!PlatformService.getInstance().isCapacitor) return;
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    // Always clear our ranges first, so disabling / changing settings can't leave stale alarms.
    await LocalNotifications.cancel({ notifications: ID_POOL });

    if (!isNostrMajlisEnabled()) return;
    const s = getNostrMajlisSettings();
    const wantPrayers = !!s.reminders?.enabled;
    const wantHolidays = !!s.holidayReminder?.enabled;
    if (!wantPrayers && !wantHolidays) return;

    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
    if (perm.display !== 'granted') {
      diagLog('addons', 'nostr-majlis: native notification permission denied');
      return;
    }

    const now = Date.now();
    const notifications: NotificationSpec[] = [];
    if (wantPrayers) this.buildPrayers(notifications, s, now);
    if (wantHolidays) this.buildHolidays(notifications, s, now);

    if (notifications.length) await LocalNotifications.schedule({ notifications });
    diagLog('addons', 'nostr-majlis: native reminders scheduled', { count: notifications.length });
  }

  private buildPrayers(out: NotificationSpec[], s: ReturnType<typeof getNostrMajlisSettings>, now: number): void {
    let n = 0;
    for (const day of getUpcomingDays(PRAYER_DAYS_AHEAD)) {
      for (const [key, name] of PRAYERS) {
        if (!s.reminders.prayers[key]) continue;
        const pm = parseHHMM(day.times[key]);
        if (pm === null) continue;
        const at = new Date(day.year, day.month, day.day, Math.floor(pm / 60), pm % 60, 0).getTime()
          - s.reminders.offsetMin * 60_000;
        if (at <= now) continue;
        if (n >= PRAYER_POOL) return;
        out.push({
          id: PRAYER_ID_BASE + n,
          title: `${name} prayer`,
          body: `In ${s.reminders.offsetMin} min (${day.times[key]})`,
          // allowWhileIdle: time-critical, must fire during Doze / while the phone is asleep.
          schedule: { at: new Date(at), allowWhileIdle: true },
        });
        n++;
      }
    }
  }

  private buildHolidays(out: NotificationSpec[], s: ReturnType<typeof getNostrMajlisSettings>, now: number): void {
    const days = s.holidayReminder.daysBefore;
    let n = 0;
    for (const rem of getHolidayReminders(days)) {
      if (rem.fireAt.getTime() <= now) continue;
      if (n >= HOLIDAY_POOL) break;
      out.push({
        id: HOLIDAY_ID_BASE + n,
        title: rem.name,
        body: `In ${days} day${days === 1 ? '' : 's'} (${formatDateByCalendar(rem.date)})`,
        schedule: { at: rem.fireAt, allowWhileIdle: true },
      });
      n++;
    }
  }

  async destroy(): Promise<void> {
    if (this.subId) { this.bus.off(this.subId); this.subId = null; }
    if (this.debounce !== null) { clearTimeout(this.debounce); this.debounce = null; }
    if (this.resumeHandle) { await this.resumeHandle.remove().catch(() => {}); this.resumeHandle = null; }
    if (PlatformService.getInstance().isCapacitor) {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.cancel({ notifications: ID_POOL }).catch(() => {});
    }
    diagLog('addons', 'nostr-majlis: native reminders destroyed');
  }
}
