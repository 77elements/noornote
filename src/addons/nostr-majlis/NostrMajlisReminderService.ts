/**
 * NostrMajlisReminderService - in-app prayer reminders (Electron / Web).
 *
 * Polls every 30s; when the device-local time enters [prayer − offset, prayer) for an
 * enabled prayer, it shows the core AlertBar once (deduped per day+prayer). When the window
 * is NOT focused it additionally fires an OS notification (same web Notification API in both
 * the Electron renderer and the browser), so the reminder surfaces even when NoorNote is in
 * the background / minimised. Times come from the active source (Diyanet cache or local
 * calculation). Owned by the addon runtime, so the timer is cleared on logout /
 * account-switch / toggle-off.
 *
 * Not used on Capacitor: there NostrMajlisNativeReminders schedules OS-level alarms that fire
 * even when the app is closed. Only one path runs per device, so reminders never double up.
 *
 * Timezone note: comparison uses device-local time, correct when the chosen city is where
 * the user is (the normal case). A foreign city only shifts reminder timing, not the
 * displayed times.
 */

import { AlertBarService } from '../../services/AlertBarService';
import { Router } from '../../services/Router';
import { diagLog } from '../../services/DiagnosticLogger';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { isNostrMajlisEnabled, getNostrMajlisSettings, type ReminderPrayers } from './index';
import { getActiveTimes, parseHHMM } from './activeTimes';
import { getHolidayReminders } from './holidays';
import { formatDateByCalendar } from '../../helpers/formatTimestamp';

const POLL_MS = 30_000;
const PRAYERS: [keyof ReminderPrayers, string][] = [
  ['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
];

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export class NostrMajlisReminderService {
  private static instance: NostrMajlisReminderService | null = null;

  static getInstance(): NostrMajlisReminderService {
    if (!NostrMajlisReminderService.instance) NostrMajlisReminderService.instance = new NostrMajlisReminderService();
    return NostrMajlisReminderService.instance;
  }

  private timer: number | null = null;
  private shown = new Set<string>(); // `${yyyy-m-d}:${prayerKey}` already fired today
  private shownHolidays = new Set<string>(); // `${holidayDate}:${key}` already fired

  start(): void {
    if (this.timer !== null) return;
    this.ensureOsPermission();
    void this.scan();
    this.timer = window.setInterval(() => void this.scan(), POLL_MS);
  }

  /** Ask once for OS-notification permission so background reminders can show. */
  private ensureOsPermission(): void {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') void Notification.requestPermission();
  }

  private scan(): void {
    if (!isNostrMajlisEnabled()) return;
    const s = getNostrMajlisSettings();
    const now = new Date();
    if (s.reminders?.enabled) this.scanPrayers(s, now);
    if (s.holidayReminder?.enabled) this.scanHolidays(s, now);
  }

  private scanPrayers(s: ReturnType<typeof getNostrMajlisSettings>, now: Date): void {
    const times = getActiveTimes();
    if (!times) return;

    const dateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // Drop yesterday's dedup keys.
    for (const k of this.shown) if (!k.startsWith(`${dateStr}:`)) this.shown.delete(k);

    // Persisted acknowledgements survive reload/restart — without this the banner
    // reappears on every reload while still inside the [prayer − offset, prayer) window.
    const acked = this.loadAckedPrayers();

    for (const [key, name] of PRAYERS) {
      if (!s.reminders.prayers[key]) continue;
      const pm = parseHHMM(times[key]);
      if (pm === null) continue;
      const reminderMin = pm - s.reminders.offsetMin;
      if (nowMin < reminderMin || nowMin >= pm) continue;

      const dedup = `${dateStr}:${key}`;
      if (this.shown.has(dedup)) continue;
      // Already acknowledged for this prayer today — never re-show across reloads.
      if (acked.has(dedup)) continue;
      this.shown.add(dedup);

      const remaining = pm - nowMin;
      diagLog('addons', 'nostr-majlis: reminder fired', { prayer: key, at: times[key], remaining });
      AlertBarService.getInstance().show({
        text: `${name} prayer in ${remaining} min (${times[key]})`,
        onTextClick: () => Router.getInstance().navigate('/addons/nostr-majlis'),
        onOk: () => this.ackPrayer(dedup, dateStr),
      });
      this.notifyOs(name, times[key], remaining);
    }
  }

  /** Acknowledged prayer dedup keys, persisted per account so "Ok" sticks across restarts. */
  private loadAckedPrayers(): Set<string> {
    const arr = PerAccountLocalStorage.getInstance().get<string[]>(StorageKeys.NOSTR_MAJLIS_PRAYERS_ACK, []);
    return new Set(arr);
  }

  /** Persist an acknowledged prayer and prune entries that aren't from today. */
  private ackPrayer(dedup: string, dateStr: string): void {
    const set = this.loadAckedPrayers();
    set.add(dedup);

    // Keys are `${yyyy-m-d}:${prayerKey}` — keep only today's, drop past days.
    // Mirrors the in-memory `shown` prune (format-agnostic, no Date parsing).
    const pruned = [...set].filter(k => k.startsWith(`${dateStr}:`));

    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTR_MAJLIS_PRAYERS_ACK, pruned);
    diagLog('addons', 'nostr-majlis: prayer reminder acknowledged', { dedup });
  }

  /** Fire the holiday reminder due today (09:00, N days before), once per holiday occurrence. */
  private scanHolidays(s: ReturnType<typeof getNostrMajlisSettings>, now: Date): void {
    const days = s.holidayReminder.daysBefore;
    const acked = this.loadAckedHolidays();
    for (const rem of getHolidayReminders(days)) {
      // Due = fire time reached AND still the reminder day (don't replay a day we missed).
      if (rem.fireAt.getTime() > now.getTime()) continue;
      if (!sameDay(rem.fireAt, now)) continue;

      const dedup = `${rem.date.toDateString()}:${rem.key}`;
      if (this.shownHolidays.has(dedup)) continue;
      // Persisted acknowledgement: once the user clicked "Ok", never re-show this
      // occurrence — survives reload / restart / account-switch.
      if (acked.has(dedup)) continue;
      this.shownHolidays.add(dedup);

      const text = `${rem.name} in ${days} day${days === 1 ? '' : 's'} (${formatDateByCalendar(rem.date)})`;
      diagLog('addons', 'nostr-majlis: holiday reminder fired', { holiday: rem.key, daysBefore: days });
      AlertBarService.getInstance().show({
        text,
        onTextClick: () => Router.getInstance().navigate('/addons/nostr-majlis'),
        onOk: () => this.ackHoliday(dedup),
      });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus()) {
        const n = new Notification(rem.name, { body: text, tag: `nostr-majlis-holiday-${rem.key}` });
        n.onclick = () => { window.focus(); Router.getInstance().navigate('/addons/nostr-majlis'); };
      }
    }
  }

  /** Acknowledged holiday dedup keys, persisted per account so "Ok" sticks across restarts. */
  private loadAckedHolidays(): Set<string> {
    const arr = PerAccountLocalStorage.getInstance().get<string[]>(StorageKeys.NOSTR_MAJLIS_HOLIDAYS_ACK, []);
    return new Set(arr);
  }

  /** Persist an acknowledged holiday and prune entries whose holiday date has passed. */
  private ackHoliday(dedup: string): void {
    const set = this.loadAckedHolidays();
    set.add(dedup);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const pruned = [...set].filter(k => {
      const d = new Date(k.split(':')[0]!); // `${holidayDate.toDateString()}:${key}`
      return isNaN(d.getTime()) || d.getTime() >= todayStart.getTime();
    });

    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTR_MAJLIS_HOLIDAYS_ACK, pruned);
    diagLog('addons', 'nostr-majlis: holiday reminder acknowledged', { dedup });
  }

  /** Background OS notification — only when the window isn't focused (else the AlertBar is enough). */
  private notifyOs(name: string, time: string, remaining: number): void {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;
    const n = new Notification(`${name} prayer`, {
      body: `In ${remaining} min (${time})`,
      tag: `nostr-majlis-${name}`,
    });
    n.onclick = () => { window.focus(); Router.getInstance().navigate('/addons/nostr-majlis'); };
  }

  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.shown.clear();
    this.shownHolidays.clear();
    NostrMajlisReminderService.instance = null;
    diagLog('addons', 'nostr-majlis: ReminderService destroyed');
  }
}
