/**
 * NostrMajlisReminderService - in-app prayer reminders via the core AlertBar.
 *
 * Polls every 30s; when the device-local time enters [prayer − offset, prayer) for an
 * enabled prayer, it shows the AlertBar once (deduped per day+prayer). Times come from the
 * active source (Diyanet cache or local calculation). Owned by the addon runtime, so the
 * timer is cleared on logout / account-switch / toggle-off. In-app only — sleep-screen
 * notifications are S4. See docs/todos/muslims-addon.md.
 *
 * Timezone note: comparison uses device-local time, correct when the chosen city is where
 * the user is (the normal case). A foreign city only shifts reminder timing, not the
 * displayed times. Native notifications (S4) can refine this.
 */

import { AlertBarService } from '../../services/AlertBarService';
import { Router } from '../../services/Router';
import { diagLog } from '../../services/DiagnosticLogger';
import { isNostrMajlisEnabled, getNostrMajlisSettings, type ReminderPrayers } from './index';
import { DiyanetService } from './DiyanetService';
import { computeTimes, isCalcMethod } from './SalahService';

const POLL_MS = 30_000;
const PRAYERS: [keyof ReminderPrayers, string][] = [
  ['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
];

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

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
    void this.scan();
    this.timer = window.setInterval(() => void this.scan(), POLL_MS);
  }

  private todayTimes(): { fajr: string; dhuhr: string; asr: string; maghrib: string; isha: string } | null {
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

  private scan(): void {
    if (!isNostrMajlisEnabled()) return;
    const s = getNostrMajlisSettings();
    if (!s.reminders?.enabled) return;

    const times = this.todayTimes();
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
    }
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
