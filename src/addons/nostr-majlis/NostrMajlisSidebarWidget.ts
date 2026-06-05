/**
 * NostrMajlisSidebarWidget - current-prayer / countdown widget in the left sidebar.
 *
 * Mounts into the static `.nm-sidebar-widget-container` (MainLayout, between the primary
 * nav and the data-saver toggle) when the `sidebarWidget` setting is on. Two rows:
 *   current prayer | "time left" | next prayer
 *   current clock  | H:MM left   | next start
 * Ticks every 10s; owned by the runtime so the interval/DOM are cleared on toggle/destroy.
 */

import { getNostrMajlisSettings, type ReminderPrayers } from './index';
import { getActiveTimes, type DayPrayerTimes } from './activeTimes';
import { escapeHtml } from '../../helpers/escapeHtml';

// Sunrise IS a period boundary: Fajr lasts only until sunrise, then we are in the
// "Sunrise" period until Dhuhr (no obligatory prayer, but the correct current label).
const ORDER: [string, keyof DayPrayerTimes][] = [
  ['Fajr', 'fajr'], ['Sunrise', 'sunrise'], ['Dhuhr', 'dhuhr'], ['Asr', 'asr'], ['Maghrib', 'maghrib'], ['Isha', 'isha'],
];

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

interface WidgetData { currentName: string; nextName: string; nextKey: keyof DayPrayerTimes; nextTime: string; countdownMin: number; }

function compute(times: DayPrayerTimes, nowMin: number): WidgetData | null {
  const ms = ORDER
    .map(([name, key]) => ({ name, key, m: parseHHMM(times[key] ?? '') }))
    .filter((x): x is { name: string; key: keyof DayPrayerTimes; m: number } => x.m !== null);
  if (ms.length === 0) return null;
  const last = ms.length - 1;

  let curIdx = -1;
  for (let i = 0; i < ms.length; i++) if (ms[i]!.m <= nowMin) curIdx = i;

  let cur, next, countdown;
  if (curIdx === -1) { cur = ms[last]!; next = ms[0]!; countdown = ms[0]!.m - nowMin; }                 // before the first → in the last period (Isha)
  else if (curIdx === last) { cur = ms[last]!; next = ms[0]!; countdown = (1440 - nowMin) + ms[0]!.m; }  // in the last period → next is tomorrow's first
  else { cur = ms[curIdx]!; next = ms[curIdx + 1]!; countdown = ms[curIdx + 1]!.m - nowMin; }

  return { currentName: cur.name, nextName: next.name, nextKey: next.key, nextTime: times[next.key] ?? '--', countdownMin: countdown };
}

export class NostrMajlisSidebarWidget {
  private container: HTMLElement | null = null;
  private el: HTMLElement | null = null;
  private timer: number | null = null;

  /** Find the sidebar slot and render according to the current setting. */
  mount(): void {
    this.container = document.querySelector('.nm-sidebar-widget-container');
    this.refresh();
  }

  /** Re-evaluate the setting: show + start ticking, or tear down. */
  refresh(): void {
    if (!this.container) this.container = document.querySelector('.nm-sidebar-widget-container');
    if (!this.container) return;

    if (!getNostrMajlisSettings().sidebarWidget) { this.teardown(); return; }

    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'nm-widget';
      this.container.appendChild(this.el);
    }
    this.update();
    if (this.timer === null) this.timer = window.setInterval(() => this.update(), 10_000);
  }

  private update(): void {
    if (!this.el) return;
    const times = getActiveTimes();
    const now = new Date();
    const data = times ? compute(times, now.getHours() * 60 + now.getMinutes()) : null;

    if (!data) {
      this.el.innerHTML = `<div class="nm-widget__empty">Prayer times not set</div>`;
      return;
    }

    const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const left = `${Math.floor(data.countdownMin / 60)}:${pad(data.countdownMin % 60)}`;

    // Pulsate the "time left" value once we're inside the reminder window for the next
    // prayer (i.e. a reminder is about to / would fire). Uses the same .pulsate as "Loading…".
    const r = getNostrMajlisSettings().reminders;
    // Sunrise is a period but not a reminder prayer → never pulsates.
    const pulsate = r.enabled && data.nextKey !== 'sunrise' && r.prayers[data.nextKey as keyof ReminderPrayers]
      && data.countdownMin >= 0 && data.countdownMin <= r.offsetMin;

    this.el.innerHTML = `
      <div class="nm-widget__row nm-widget__head"><span>${escapeHtml(data.currentName)}</span><span>time left</span><span>${escapeHtml(data.nextName)}</span></div>
      <div class="nm-widget__row nm-widget__vals"><span>${clock}</span><span class="${pulsate ? 'pulsate' : ''}">${left}</span><span>${escapeHtml(data.nextTime)}</span></div>
    `;
  }

  private teardown(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.el?.remove();
    this.el = null;
  }

  destroy(): void {
    this.teardown();
    this.container = null;
  }
}
