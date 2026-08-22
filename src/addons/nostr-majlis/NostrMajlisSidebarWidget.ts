/**
 * NostrMajlisSidebarWidget - current-prayer / countdown widget in the left sidebar.
 *
 * Mounts into the static `.nm-sidebar-widget-container` (MainLayout, between the primary
 * nav and the data-saver toggle) when the `sidebarWidget` setting is on. Two rows:
 *   current prayer | "time left" | next prayer
 *   current clock  | H:MM left   | next start
 * Ticks every 10s; owned by the runtime so the interval/DOM are cleared on toggle/destroy.
 *
 * When no times are available AND the source is Diyanet (e.g. the cached month ran out at a
 * month boundary), the empty state offers a "Fetch times again" link that runs the very same
 * fetch as the addon page's "Fetch Prayer Times" button - so the user need not open the addon.
 */

import { getNostrMajlisSettings, type ReminderPrayers } from './index';
import {
  getActiveTimes,
  parseHHMM,
  activeDiyanetIlceId,
  type DayPrayerTimes,
} from './activeTimes';
import { DiyanetService } from './DiyanetService';
import { escapeHtml } from '../../helpers/escapeHtml';

// Sunrise IS a period boundary: Fajr lasts only until sunrise, then we are in the
// "Sunrise" period until Dhuhr (no obligatory prayer, but the correct current label).
const ORDER: [string, keyof DayPrayerTimes][] = [
  ['Fajr', 'fajr'],
  ['Sunrise', 'sunrise'],
  ['Dhuhr', 'dhuhr'],
  ['Asr', 'asr'],
  ['Maghrib', 'maghrib'],
  ['Isha', 'isha'],
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

interface WidgetData {
  currentName: string;
  nextName: string;
  nextKey: keyof DayPrayerTimes;
  nextTime: string;
  countdownMin: number;
}

function compute(times: DayPrayerTimes, nowMin: number): WidgetData | null {
  const ms = ORDER.map(([name, key]) => ({
    name,
    key,
    m: parseHHMM(times[key] ?? ''),
  })).filter(
    (x): x is { name: string; key: keyof DayPrayerTimes; m: number } =>
      x.m !== null
  );
  if (ms.length === 0) return null;
  const last = ms.length - 1;

  let curIdx = -1;
  for (let i = 0; i < ms.length; i++) if (ms[i]!.m <= nowMin) curIdx = i;

  let cur, next, countdown;
  if (curIdx === -1) {
    cur = ms[last]!;
    next = ms[0]!;
    countdown = ms[0]!.m - nowMin;
  } // before the first → in the last period (Isha)
  else if (curIdx === last) {
    cur = ms[last]!;
    next = ms[0]!;
    countdown = 1440 - nowMin + ms[0]!.m;
  } // in the last period → next is tomorrow's first
  else {
    cur = ms[curIdx]!;
    next = ms[curIdx + 1]!;
    countdown = ms[curIdx + 1]!.m - nowMin;
  }

  return {
    currentName: cur.name,
    nextName: next.name,
    nextKey: next.key,
    nextTime: times[next.key] ?? '--',
    countdownMin: countdown,
  };
}

export class NostrMajlisSidebarWidget {
  private container: HTMLElement | null = null;
  private el: HTMLElement | null = null;
  private timer: number | null = null;
  private fetching = false;

  // Delegated so it survives the innerHTML rewrites in update(); removed in teardown().
  private onClick = (e: MouseEvent): void => {
    if (
      (e.target as HTMLElement | null)?.closest('[data-action="nm-refetch"]')
    ) {
      e.preventDefault();
      void this.refetch();
    }
  };

  /** Find the sidebar slot and render according to the current setting. */
  mount(): void {
    this.container = document.querySelector('.nm-sidebar-widget-container');
    this.refresh();
  }

  /** Re-evaluate the setting: show + start ticking, or tear down. */
  refresh(): void {
    if (!this.container)
      this.container = document.querySelector('.nm-sidebar-widget-container');
    if (!this.container) return;

    if (!getNostrMajlisSettings().sidebarWidget) {
      this.teardown();
      return;
    }

    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'nm-widget';
      this.el.addEventListener('click', this.onClick);
      this.container.appendChild(this.el);
    }
    this.update();
    if (this.timer === null)
      this.timer = window.setInterval(() => this.update(), 10_000);
  }

  private update(): void {
    if (!this.el || this.fetching) return; // don't clobber the "Fetching…" state mid-fetch
    const times = getActiveTimes();
    const now = new Date();
    const data = times
      ? compute(times, now.getHours() * 60 + now.getMinutes())
      : null;

    if (!data) {
      // Diyanet can run out (rolling window); offer an in-place re-fetch. Calc sources can't.
      const refetch =
        activeDiyanetIlceId() !== null
          ? `<button type="button" class="nm-widget__refetch" data-action="nm-refetch">Fetch times again</button>`
          : '';
      this.el.innerHTML = `<div class="nm-widget__empty">Prayer times not set</div>${refetch}`;
      return;
    }

    const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const left = `${Math.floor(data.countdownMin / 60)}:${pad(data.countdownMin % 60)}`;

    // Pulsate the "time left" value once we're inside the reminder window for the next
    // prayer (i.e. a reminder is about to / would fire). Uses the same .pulsate as "Loading…".
    const r = getNostrMajlisSettings().reminders;
    // Sunrise is a period but not a reminder prayer → never pulsates.
    const pulsate =
      r.enabled &&
      data.nextKey !== 'sunrise' &&
      r.prayers[data.nextKey as keyof ReminderPrayers] &&
      data.countdownMin >= 0 &&
      data.countdownMin <= r.offsetMin;

    this.el.innerHTML = `
      <div class="nm-widget__row nm-widget__head"><span>${escapeHtml(data.currentName)}</span><span>time left</span><span>${escapeHtml(data.nextName)}</span></div>
      <div class="nm-widget__row nm-widget__vals"><span>${clock}</span><span class="${pulsate ? 'pulsate' : ''}">${left}</span><span>${escapeHtml(data.nextTime)}</span></div>
    `;
  }

  /** Fetch + cache the active Diyanet district's times (same call as the addon page button). */
  private async refetch(): Promise<void> {
    const ilceId = activeDiyanetIlceId();
    if (!ilceId || this.fetching || !this.el) return;
    this.fetching = true;
    this.el.innerHTML = `<div class="nm-widget__empty pulsate">Fetching times…</div>`;
    try {
      await DiyanetService.getInstance().fetchAndCacheTimes(ilceId);
    } catch {
      /* update() re-renders the empty state + link so the user can retry */
    } finally {
      this.fetching = false;
      this.update();
    }
  }

  private teardown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.el?.removeEventListener('click', this.onClick);
    this.el?.remove();
    this.el = null;
    this.fetching = false;
  }

  destroy(): void {
    this.teardown();
    this.container = null;
  }
}
