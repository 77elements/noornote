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
import { isNostrMajlisEnabled, getNostrMajlisSettings, type ReminderPrayers } from './index';
import { getActiveTimes, parseHHMM } from './activeTimes';

const POLL_MS = 30_000;
const PRAYERS: [keyof ReminderPrayers, string][] = [
  ['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
];

export class NostrMajlisReminderService {
  private static instance: NostrMajlisReminderService | null = null;

  static getInstance(): NostrMajlisReminderService {
    if (!NostrMajlisReminderService.instance) NostrMajlisReminderService.instance = new NostrMajlisReminderService();
    return NostrMajlisReminderService.instance;
  }

  private timer: number | null = null;
  private shown = new Set<string>(); // `${yyyy-m-d}:${prayerKey}` already fired today

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
    if (!s.reminders?.enabled) return;

    const times = getActiveTimes();
    if (!times) return;

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // Drop yesterday's dedup keys.
    for (const k of this.shown) if (!k.startsWith(`${dateStr}:`)) this.shown.delete(k);

    for (const [key, name] of PRAYERS) {
      if (!s.reminders.prayers[key]) continue;
      const pm = parseHHMM(times[key]);
      if (pm === null) continue;
      const reminderMin = pm - s.reminders.offsetMin;
      if (nowMin < reminderMin || nowMin >= pm) continue;

      const dedup = `${dateStr}:${key}`;
      if (this.shown.has(dedup)) continue;
      this.shown.add(dedup);

      const remaining = pm - nowMin;
      diagLog('addons', 'nostr-majlis: reminder fired', { prayer: key, at: times[key], remaining });
      AlertBarService.getInstance().show({
        text: `${name} prayer in ${remaining} min (${times[key]})`,
        onTextClick: () => Router.getInstance().navigate('/addons/nostr-majlis'),
        onOk: () => { /* acknowledge + dismiss */ },
      });
      this.notifyOs(name, times[key], remaining);
    }
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
    NostrMajlisReminderService.instance = null;
    diagLog('addons', 'nostr-majlis: ReminderService destroyed');
  }
}
