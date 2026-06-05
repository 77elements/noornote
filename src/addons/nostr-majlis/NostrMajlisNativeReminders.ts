/**
 * NostrMajlisNativeReminders - native scheduled prayer reminders (Capacitor / Android).
 *
 * Unlike the in-app AlertBar (NostrMajlisReminderService), these fire even when the app is
 * closed or the phone is asleep: it schedules OS-level local notifications at [prayer − offset]
 * for the next few days, using @capacitor/local-notifications. On Capacitor this REPLACES the
 * AlertBar reminder (the OS notification also shows in the foreground), so they don't double up.
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

const DAYS_AHEAD = 7;
const ID_BASE = 90_000_000; // dedicated id range so we can cancel exactly our own notifications
const PRAYERS: [keyof ReminderPrayers, string][] = [
  ['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
];
const POOL = DAYS_AHEAD * PRAYERS.length;
const ID_POOL = Array.from({ length: POOL }, (_, i) => ({ id: ID_BASE + i }));
const RESCHEDULE_DEBOUNCE_MS = 600;

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

    // Always clear our range first, so disabling / changing settings can't leave stale alarms.
    await LocalNotifications.cancel({ notifications: ID_POOL });

    if (!isNostrMajlisEnabled()) return;
    const s = getNostrMajlisSettings();
    if (!s.reminders?.enabled) return;

    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
    if (perm.display !== 'granted') {
      diagLog('addons', 'nostr-majlis: native notification permission denied');
      return;
    }

    const now = Date.now();
    const notifications: Array<{ id: number; title: string; body: string; schedule: { at: Date; allowWhileIdle: boolean } }> = [];
    let n = 0;

    outer:
    for (const day of getUpcomingDays(DAYS_AHEAD)) {
      for (const [key, name] of PRAYERS) {
        if (!s.reminders.prayers[key]) continue;
        const pm = parseHHMM(day.times[key]);
        if (pm === null) continue;
        const at = new Date(day.year, day.month, day.day, Math.floor(pm / 60), pm % 60, 0).getTime()
          - s.reminders.offsetMin * 60_000;
        if (at <= now) continue;
        if (n >= POOL) break outer;
        notifications.push({
          id: ID_BASE + n,
          title: `${name} prayer`,
          body: `In ${s.reminders.offsetMin} min (${day.times[key]})`,
          // allowWhileIdle: time-critical, must fire during Doze / while the phone is asleep.
          schedule: { at: new Date(at), allowWhileIdle: true },
        });
        n++;
      }
    }

    if (notifications.length) await LocalNotifications.schedule({ notifications });
    diagLog('addons', 'nostr-majlis: native reminders scheduled', { count: notifications.length });
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
