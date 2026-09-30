/**
 * NostrMajlisSidebarWidget - current-prayer / countdown widget in the left sidebar.
 *
 * Mounts into the static sidebar slot `[data-sidebar-widget="nostr-majlis"]`
 * (MainLayout, between the BTC price widget and the data-saver toggle) when the
 * `sidebarWidget` setting is on. Two rows:
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
import {
  getDailyAyah,
  dateKeyOf,
  truncateText,
  WIDGET_TRANSLATION_MAX,
  type DailyAyah,
} from './quranDaily';
import { Router } from '../../services/Router';
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

  // Daily Quran ayah state — survives the 10s re-renders; the fetch itself is
  // day-cached inside getDailyAyah, we only re-check on date-key change.
  private quranAyah: DailyAyah | null = null;
  private quranDateKey = '';
  private quranLoading = false;

  // Delegated so it survives the innerHTML rewrites in update(); removed in teardown().
  // The in-place re-fetch is handled here; "Show tafsir" is a plain link to
  // the Daily Ayah tab (global anchor handling navigates), any other click
  // opens the addon page.
  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-action="nm-refetch"]')) {
      e.preventDefault();
      void this.refetch();
      return;
    }
    const link = target?.closest('a');
    if (link) {
      // SPA navigation for the widget's own links (e.g. "Show tafsir" →
      // the Daily Ayah tab); the app does not intercept raw anchors.
      e.preventDefault();
      Router.getInstance().navigate(link.getAttribute('href') ?? '');
      return;
    }
    Router.getInstance().navigate('/addons/nostr-majlis');
  };

  /** Find the sidebar slot and render according to the current setting. */
  mount(): void {
    this.container = document.querySelector(
      '[data-sidebar-widget="nostr-majlis"]'
    );
    this.refresh();
  }

  /** Re-evaluate the setting: show + start ticking, or tear down. */
  refresh(): void {
    if (!this.container)
      this.container = document.querySelector(
        '[data-sidebar-widget="nostr-majlis"]'
      );
    if (!this.container) return;

    if (!getNostrMajlisSettings().sidebarWidget) {
      this.teardown();
      return;
    }

    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'sidebar-widget';
      this.el.title = 'Open Nostr Majlis';
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
          ? `<button type="button" class="sidebar-widget__refetch" data-action="nm-refetch">Fetch times again</button>`
          : '';
      this.el.innerHTML = `<div class="sidebar-widget__empty">Prayer times not set</div>${refetch}`;
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
      <div class="sidebar-widget__row sidebar-widget__head"><span>${escapeHtml(data.currentName)}</span><span>time left</span><span>${escapeHtml(data.nextName)}</span></div>
      <div class="sidebar-widget__row sidebar-widget__vals"><span>${clock}</span><span class="${pulsate ? 'pulsate' : ''}">${left}</span><span>${escapeHtml(data.nextTime)}</span></div>
      <div class="nm-quran" data-el="nm-quran"></div>
    `;
    void this.updateQuran();
  }

  /**
   * Daily ayah section below the prayer rows. Hidden entirely when the
   * `quranDaily` setting is off; pulsates while the first fetch runs; falls
   * back to the last cached ayah inside getDailyAyah when offline.
   */
  private async updateQuran(): Promise<void> {
    if (!this.el) return;
    const host = this.el.querySelector('[data-el="nm-quran"]');
    if (!host) return;
    if (!getNostrMajlisSettings().quranDaily) {
      host.innerHTML = '';
      return;
    }

    const today = dateKeyOf(new Date());
    if (!this.quranAyah || this.quranDateKey !== today) {
      if (!this.quranLoading) {
        host.innerHTML = `<div class="nm-quran__divider"></div><div class="nm-quran__loading pulsate">Loading the daily ayah…</div>`;
        this.quranLoading = true;
        try {
          const ayah = await getDailyAyah();
          if (ayah) {
            this.quranAyah = ayah;
            this.quranDateKey = today;
          }
        } finally {
          this.quranLoading = false;
        }
      }
      if (!this.quranAyah) {
        // In-flight (quranLoading) → keep the pulsate; fetch settled with
        // nothing cached → calm unavailable state. getDailyAyah marked the day
        // as failed, so no retry storm: the next day retries automatically.
        host.innerHTML = `<div class="nm-quran__divider"></div><div class="nm-quran__loading${this.quranLoading ? ' pulsate' : ''}">${this.quranLoading ? 'Loading the daily ayah…' : 'Daily ayah unavailable — will retry tomorrow.'}</div>`;
        return;
      }
    }
    this.renderQuran();
  }

  /**
   * Render the ayah section: English translation (truncated, clamped) with
   * the source reference as its own always-visible line below (inside the
   * clamped paragraph it would be cut off whenever the text runs long), plus
   * a "Show tafsir" deep-link into the addon's Daily Ayah tab.
   */
  private renderQuran(): void {
    if (!this.el) return;
    const host = this.el.querySelector('[data-el="nm-quran"]');
    if (!host || !this.quranAyah) return;
    const a = this.quranAyah;
    const ref = `[${a.surah}:${a.ayah}]`;

    host.innerHTML = `
      <hr class="nm-quran__divider" />
      ${a.english ? `<p class="nm-quran__translation nm-quran__translation--clamp">${escapeHtml(truncateText(a.english, WIDGET_TRANSLATION_MAX))}</p>` : ''}
      <div class="l-row--split">
        <div>${a.tafsir ? `<a class="nm-quran__hint" href="/addons/nostr-majlis/daily-ayah">Show tafsir</a>` : ''}</div>
        <div><span class="nm-quran__ref-line">${escapeHtml(ref)}</span></div>
      </div>
    `;
  }

  /** Fetch + cache the active Diyanet district's times (same call as the addon page button). */
  private async refetch(): Promise<void> {
    const ilceId = activeDiyanetIlceId();
    if (!ilceId || this.fetching || !this.el) return;
    this.fetching = true;
    this.el.innerHTML = `<div class="sidebar-widget__empty pulsate">Fetching times…</div>`;
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
