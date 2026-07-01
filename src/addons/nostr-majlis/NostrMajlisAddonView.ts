/**
 * NostrMajlisAddonView - settings page + inline Salah panel (route `/addons/nostr-majlis`).
 *
 * Toggle (emits `nostr-majlis:addon-toggle`). When enabled: one panel section holds the
 * Source dropdown + location picker + today's prayer times. Source is either
 *  - Diyanet (official, online): Diyanet's Country->Region->District list, official times
 *    fetched + persistently cached; a "Fetch Prayer Times" button appends the next ~30 days.
 *  - a calculation method (MWL, ISNA, …): GeoNames Country->Region->City + Asr madhab,
 *    computed locally (offline).
 * A separate Reminders section configures the in-app AlertBar reminders. Selection persists.
 * See docs/todos/muslims-addon.md.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { AddonLoader } from '../AddonLoader';
import type { NostrMajlisRuntime } from './runtime';
import { CustomDropdown, type DropdownOption } from '../../components/ui/CustomDropdown';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { formatDateByCalendar } from '../../helpers/formatTimestamp';
import { setupTabClickHandlers, switchTabWithContent } from '../../helpers/TabsHelper';
import { getHolidaysForGregorianYear } from './holidays';
import { DhikrModal } from './DhikrModal';
import { UserProfileService } from '../../services/UserProfileService';
import { ModalService } from '../../services/ModalService';
import type { DhikrService } from './DhikrService';
import type { DhikrRound } from './dhikr';
import {
  isNostrMajlisEnabled, setNostrMajlisEnabled,
  getNostrMajlisSettings, setNostrMajlisSettings,
  type ReminderPrayers,
} from './index';
import { DiyanetService, type DiyanetPlace, type DiyanetDayTimes } from './DiyanetService';
import {
  loadCityData, regionOptions, cityOptions, resolveCity, type CityData,
} from './CityDataService';
import { CALC_METHODS, computeTimes, type ComputedTimes } from './SalahService';

const PICK = '__pick__';
const MAJLIS_TABS: string[] = ['salah', 'holidays', 'dhikr'];
const ZERO: ComputedTimes = { fajr: '00:00', sunrise: '00:00', dhuhr: '00:00', asr: '00:00', maghrib: '00:00', isha: '00:00' };
const PRAYERS: [keyof ComputedTimes, string][] = [
  ['fajr', 'Fajr'], ['sunrise', 'Sunrise'], ['dhuhr', 'Dhuhr'],
  ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
];
const SOURCE_OPTIONS: DropdownOption[] = [
  { value: 'diyanet', label: 'Diyanet (official, online)' },
  ...CALC_METHODS,
];
const MADHAB_OPTIONS: DropdownOption[] = [
  { value: 'shafi', label: 'Standard (Shafi / Maliki / Hanbali)' },
  { value: 'hanafi', label: 'Hanafi' },
];
const REMINDER_PRAYERS: [keyof ReminderPrayers, string][] = [
  ['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
];

/** Compact US-format date for the dhikr list, e.g. "6/5/26" (independent of the date-format setting). */
function shortDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

export class NostrMajlisAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private sourceDD: CustomDropdown | null = null;
  private dropdowns: CustomDropdown[] = []; // location dropdowns, disposed on panel switch

  // Reminder controls
  private masterSwitch: Switch | null = null;
  private offsetDD: CustomDropdown | null = null;
  private praySwitches: Switch[] = [];

  // Sidebar-widget toggle
  private widgetSwitch: Switch | null = null;

  // Holidays tab: which Gregorian year the table shows, and the calendar-system subscription.
  private holidayYear = new Date().getFullYear();
  private calendarSubId: string | null = null;
  private holidaySwitch: Switch | null = null;
  private holidayDaysDD: CustomDropdown | null = null;

  // Community Dhikr tab: live-data event subscription.
  private dhikrBusSub: string | null = null;
  private notifySwitch: Switch | null = null;
  // Which tab to open on mount (deep-link support, e.g. from a dhikr notification).
  private initialTab: string;
  // Author pubkeys we've already kicked a profile fetch for (avoids refetch loops on re-render).
  private requestedAuthors = new Set<string>();

  // Diyanet cascade state
  private dCountries: DiyanetPlace[] = [];
  private dRegions: DiyanetPlace[] = [];
  private dDistricts: DiyanetPlace[] = [];
  private dUlke = PICK; private dSehir = PICK; private dIlce = PICK;

  // GeoNames cascade state
  private cityData: CityData | null = null;
  private gCc = PICK; private gA1 = PICK;

  private renderToken = 0;
  private disposed = false;

  constructor(initialTab?: string) {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-nostr-majlis';
    this.initialTab = initialTab ?? 'salah';
    this.render();
  }

  private render(): void {
    this.enableSwitch = new Switch({
      label: '',
      checked: isNostrMajlisEnabled(),
      onChange: (checked) => {
        setNostrMajlisEnabled(checked);
        TypedEventBus.getInstance().emit('nostr-majlis:addon-toggle', { enabled: checked });
        ToastService.show(checked ? 'Nostr-Majlis enabled' : 'Nostr-Majlis disabled', 'success');
        void this.renderSalah();
        this.renderHolidays();
        this.renderDhikr();
      },
    });

    this.container.innerHTML = `
      <h1>Nostr-Majlis</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Nostr-Majlis</span>
          <div class="setting__control">${this.enableSwitch.render()}</div>
          <p class="setting__desc">Islamic features for NoorNote: prayer times (Salah), Islamic holidays, and community dhikr. Pick Diyanet for official times, or a calculation method computed on your device.</p>
        </div>
      </section>
      <div class="tabs tabs--scrollable" data-el="majlis-tabs" hidden>
        <button class="tab tab--active" data-tab="salah">Salah</button>
        <button class="tab" data-tab="holidays">Holidays</button>
        <button class="tab" data-tab="dhikr">Community Dhikr</button>
      </div>
      <div class="tab-content tab-content--active" data-tab-content="salah" data-addon-content="salah"></div>
      <div class="tab-content" data-tab-content="holidays" data-addon-content="holidays"></div>
      <div class="tab-content" data-tab-content="dhikr" data-addon-content="dhikr"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    setupTabClickHandlers(this.container, (tabId) => switchTabWithContent(this.container, tabId));
    void this.renderSalah();
    this.renderHolidays();
    this.renderDhikr();

    // Deep-link: open the requested tab (e.g. from a dhikr notification → /addons/nostr-majlis/dhikr).
    // Whitelist the id so a malformed URL falls back to the default (salah) instead of a blank pane.
    if (this.initialTab !== 'salah' && MAJLIS_TABS.includes(this.initialTab)) {
      switchTabWithContent(this.container, this.initialTab);
    }

    // Holiday dates follow the user's Date Format setting; re-render the table when it changes.
    this.calendarSubId = TypedEventBus.getInstance().on('settings:calendar-system-changed', () => this.renderHolidaysTable());
    // Live dhikr updates come over the bus, so this works regardless of when the service started.
    this.dhikrBusSub = TypedEventBus.getInstance().on('nostr-majlis:dhikr-changed', () => this.renderDhikrList());
  }

  private stale(token: number): boolean {
    return this.disposed || token !== this.renderToken || !isNostrMajlisEnabled();
  }

  private renderSalah(): void {
    const slot = this.container.querySelector('[data-addon-content="salah"]') as HTMLElement | null;
    if (!slot) return;

    this.disposeDropdowns();
    this.disposeReminders();
    this.widgetSwitch?.destroy(); this.widgetSwitch = null;
    this.sourceDD?.destroy(); this.sourceDD = null;

    const tabsBar = this.container.querySelector('[data-el="majlis-tabs"]') as HTMLElement | null;
    if (!isNostrMajlisEnabled()) {
      if (tabsBar) tabsBar.hidden = true;
      slot.innerHTML = '';
      return;
    }
    if (tabsBar) tabsBar.hidden = false;

    slot.innerHTML = `
      <section class="section" data-el="panel"></section>
      <section class="section" data-el="result"></section>
      <section class="section" data-el="reminders"></section>
      <section class="section" data-el="widget-settings"></section>
    `;

    void this.renderPanel();
    this.renderReminders();
    this.renderWidgetSettings();
  }

  // ---------- Sidebar widget setting ----------

  private renderWidgetSettings(): void {
    const host = this.container.querySelector('[data-el="widget-settings"]') as HTMLElement | null;
    if (!host) return;
    this.widgetSwitch?.destroy();
    this.widgetSwitch = new Switch({
      label: '',
      checked: getNostrMajlisSettings().sidebarWidget,
      onChange: (c) => {
        setNostrMajlisSettings({ ...getNostrMajlisSettings(), sidebarWidget: c });
        AddonLoader.getInstance().getRuntime<NostrMajlisRuntime>('nostr-majlis')?.widget?.refresh();
      },
    });
    host.innerHTML = `<h2 class="h4">Sidebar Widget</h2><div class="setting"><span class="setting__label">Display sidebar widget</span><div class="setting__control">${this.widgetSwitch.render()}</div><p class="setting__desc">Shows the current prayer and the time left until the next one in the sidebar.</p></div>`;
    this.widgetSwitch.setupEventListeners(host);
  }

  // ---------- Holidays tab ----------

  /** Build the Holidays tab: year heading + table + Previous/Next-year nav. */
  private renderHolidays(): void {
    const slot = this.container.querySelector('[data-addon-content="holidays"]') as HTMLElement | null;
    if (!slot) return;
    this.disposeHolidayReminders();
    if (!isNostrMajlisEnabled()) { slot.innerHTML = ''; return; }

    slot.innerHTML = `
      <section class="section">
        <h2 class="h4" data-el="holiday-year"></h2>
        <div class="ui-list nm-holidays" data-el="holiday-table"></div>
        <div class="l-row--split">
          <button class="btn btn--passive" data-action="prev-year">Previous year</button>
          <button class="btn btn--passive" data-action="next-year">Next year</button>
        </div>
        <p class="setting__desc">Dates are calculated (Umm al-Qura calendar); local moon-sighting may shift Ramadan and the Eids by a day.</p>
      </section>
      <section class="section" data-el="holiday-reminders"></section>
    `;
    slot.querySelector('[data-action="prev-year"]')?.addEventListener('click', () => { this.holidayYear -= 1; this.renderHolidaysTable(); });
    slot.querySelector('[data-action="next-year"]')?.addEventListener('click', () => { this.holidayYear += 1; this.renderHolidaysTable(); });
    this.renderHolidaysTable();
    this.renderHolidayReminders();
  }

  /** Holiday reminder section: enable toggle + days-before dropdown (1 / 3 / 7 / 10). */
  private renderHolidayReminders(): void {
    const host = this.container.querySelector('[data-el="holiday-reminders"]') as HTMLElement | null;
    if (!host) return;
    this.disposeHolidayReminders();

    const hr = getNostrMajlisSettings().holidayReminder;
    this.holidaySwitch = new Switch({
      label: '',
      checked: hr.enabled,
      onChange: (c) => {
        const s = getNostrMajlisSettings();
        setNostrMajlisSettings({ ...s, holidayReminder: { ...s.holidayReminder, enabled: c } });
        this.renderHolidayReminders();
      },
    });

    let html = `<h2 class="h4">Reminder Settings</h2><div class="setting"><span class="setting__label">Holiday reminders</span><div class="setting__control">${this.holidaySwitch.render()}</div><p class="setting__desc">Notifies you ahead of each holiday, through the same channels as the prayer reminders.</p></div>`;
    if (hr.enabled) {
      html += `<div class="setting"><span class="setting__label">Days before</span><div class="setting__control" data-control="holiday-days"></div></div>`;
    }
    host.innerHTML = html;
    this.holidaySwitch.setupEventListeners(host);

    if (hr.enabled) {
      this.holidayDaysDD = new CustomDropdown({
        options: [1, 3, 7, 10].map(n => ({ value: String(n), label: `${n} day${n === 1 ? '' : 's'} before` })),
        selectedValue: String(hr.daysBefore),
        width: '100%',
        onChange: (v) => {
          const s = getNostrMajlisSettings();
          setNostrMajlisSettings({ ...s, holidayReminder: { ...s.holidayReminder, daysBefore: parseInt(v, 10) } });
        },
      });
      host.querySelector('[data-control="holiday-days"]')?.appendChild(this.holidayDaysDD.getElement());
    }
  }

  private disposeHolidayReminders(): void {
    this.holidayDaysDD?.destroy(); this.holidayDaysDD = null;
    this.holidaySwitch?.destroy(); this.holidaySwitch = null;
  }

  // ---------- Community Dhikr tab ----------

  private dhikrService() {
    return AddonLoader.getInstance().getRuntime<NostrMajlisRuntime>('nostr-majlis')?.dhikr ?? null;
  }

  /** Build the Community Dhikr tab: "Create new dhikr" button + the live actions table. */
  private renderDhikr(): void {
    const slot = this.container.querySelector('[data-addon-content="dhikr"]') as HTMLElement | null;
    if (!slot) return;
    this.notifySwitch?.destroy(); this.notifySwitch = null;
    if (!isNostrMajlisEnabled()) { slot.innerHTML = ''; return; }

    this.notifySwitch = new Switch({
      label: 'Notify on activity',
      checked: getNostrMajlisSettings().dhikrNotifications,
      onChange: (checked) => setNostrMajlisSettings({ ...getNostrMajlisSettings(), dhikrNotifications: checked }),
    });

    slot.innerHTML = `
      <section class="section">
        <div class="l-row--split">
          <div>${this.notifySwitch.render()}</div>
          <div><button class="btn btn--primary" data-action="create-dhikr">Create new dhikr</button></div>
        </div>
        <div class="nm-dhikr-list" data-el="dhikr-list"></div>
      </section>
    `;
    this.notifySwitch.setupEventListeners(slot);
    slot.querySelector('[data-action="create-dhikr"]')?.addEventListener('click', () => new DhikrModal('create').open());
    this.renderDhikrList();
  }

  /** Render the table from the current DhikrService state (live, re-rendered on changes). */
  private renderDhikrList(): void {
    const host = this.container.querySelector('[data-el="dhikr-list"]') as HTMLElement | null;
    if (!host) return;
    const svc = this.dhikrService();
    const isAdmin = !!svc && svc.isAdmin();
    const rounds = svc ? svc.getRounds(isAdmin) : []; // admin sees moderated rounds too, to reverse them

    if (rounds.length === 0) {
      host.innerHTML = (svc && svc.isLoaded())
        ? `<p class="setting__desc">No dhikr actions yet. Create the first one.</p>`
        : `<p class="setting__desc pulsate">Looking for existing dhikrs…</p>`;
      return;
    }

    const profiles = UserProfileService.getInstance();
    this.ensureAuthorNames([...new Set(rounds.map(r => r.author))]);

    const rows = rounds.map(r => {
      const total = svc!.getTotal(r.addr);
      const complete = total >= r.goal;
      const hidden = svc!.isHidden(r.addr);
      const banned = svc!.isAuthorBanned(r.author);
      const date = escapeHtml(shortDate(new Date(r.createdAt * 1000)));
      const author = escapeHtml(profiles.getDisplayName(r.author));
      const phrase = `${escapeHtml(r.phrase)}${complete ? ' 🎉' : ''}${r.description ? `<span class="nm-dhikr__desc">${escapeHtml(r.description)}</span>` : ''}`;
      const action = complete
        ? '✅'
        : `<button class="btn btn--passive btn--mini" data-action="commit" data-addr="${escapeHtml(r.addr)}">Commit</button>`;
      const flags = `${hidden ? '<span class="nm-dhikr__flag">hidden</span>' : ''}${banned ? '<span class="nm-dhikr__flag">excluded</span>' : ''}`;
      return `<tr class="${hidden || banned ? 'is-moderated' : ''}">
        <td>${phrase}</td>
        <td>${author}${flags}</td>
        <td>${r.goal}</td>
        <td>${date}</td>
        <td>${total} / ${r.goal}</td>
        <td>${action}</td>
        ${isAdmin ? `<td class="nm-dhikr__admin">${this.adminActions(r, hidden, banned)}</td>` : ''}
      </tr>`;
    }).join('');

    host.innerHTML = `
      <table class="nm-dhikr">
        <thead><tr><th>Dhikr</th><th>Author</th><th>Count</th><th>Date</th><th>Progress</th><th></th>${isAdmin ? '<th>Moderation</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    if (svc) this.bindDhikrActions(host, svc, isAdmin);
  }

  /** The admin-only moderation buttons for one round (Edit / Delete-Un-hide / Exclude-Re-include). */
  private adminActions(r: DhikrRound, hidden: boolean, banned: boolean): string {
    const addr = escapeHtml(r.addr);
    const pk = escapeHtml(r.author);
    const edit = `<button class="btn btn--passive btn--mini" data-action="edit" data-addr="${addr}">Edit</button>`;
    const hide = hidden
      ? `<button class="btn btn--passive btn--mini" data-action="unhide" data-addr="${addr}">Un-hide</button>`
      : `<button class="btn btn--passive btn--mini" data-action="hide" data-addr="${addr}">Delete</button>`;
    const ban = banned
      ? `<button class="btn btn--passive btn--mini" data-action="unban" data-pubkey="${pk}">Re-include</button>`
      : `<button class="btn btn--passive btn--mini" data-action="ban" data-pubkey="${pk}">Exclude author</button>`;
    return `<div class="nm-dhikr__actions">${edit}${hide}${ban}</div>`;
  }

  /** Wire up the per-row buttons (commit for everyone; edit/hide/ban for the admin). */
  private bindDhikrActions(host: HTMLElement, svc: DhikrService, isAdmin: boolean): void {
    const roundFor = (btn: Element) => svc.getRounds(isAdmin).find(r => r.addr === (btn as HTMLElement).dataset.addr);
    host.querySelectorAll('[data-action="commit"]').forEach(btn => btn.addEventListener('click', () => {
      const round = roundFor(btn); if (round) new DhikrModal('commit', round).open();
    }));
    host.querySelectorAll('[data-action="edit"]').forEach(btn => btn.addEventListener('click', () => {
      const round = roundFor(btn); if (round) new DhikrModal('edit', round).open();
    }));
    host.querySelectorAll('[data-action="hide"]').forEach(btn => btn.addEventListener('click', () =>
      void this.confirmHide(svc, (btn as HTMLElement).dataset.addr ?? '')));
    host.querySelectorAll('[data-action="unhide"]').forEach(btn => btn.addEventListener('click', () =>
      void this.runModeration(() => svc.unhideRound((btn as HTMLElement).dataset.addr ?? ''))));
    host.querySelectorAll('[data-action="ban"]').forEach(btn => btn.addEventListener('click', () =>
      void this.confirmBan(svc, (btn as HTMLElement).dataset.pubkey ?? '')));
    host.querySelectorAll('[data-action="unban"]').forEach(btn => btn.addEventListener('click', () =>
      void this.runModeration(() => svc.unbanAuthor((btn as HTMLElement).dataset.pubkey ?? ''))));
  }

  private async confirmHide(svc: DhikrService, addr: string): Promise<void> {
    if (!addr) return;
    const ok = await ModalService.getInstance().confirm({
      title: 'Delete dhikr',
      message: 'Hide this dhikr from everyone? You can un-hide it later.',
      confirmText: 'Delete',
      confirmDestructive: true,
    });
    if (ok) await this.runModeration(() => svc.hideRound(addr), 'Dhikr hidden');
  }

  private async confirmBan(svc: DhikrService, pubkey: string): Promise<void> {
    if (!pubkey) return;
    const name = UserProfileService.getInstance().getDisplayName(pubkey);
    const ok = await ModalService.getInstance().confirm({
      title: 'Exclude author',
      message: `Exclude ${name}? Their dhikrs disappear and all their submissions stop counting.`,
      confirmText: 'Exclude',
      confirmDestructive: true,
    });
    if (ok) await this.runModeration(() => svc.banAuthor(pubkey), 'Author excluded');
  }

  /** Run a moderation write with a uniform success/error toast (the list re-renders via the bus). */
  private async runModeration(action: () => Promise<void>, successMsg?: string): Promise<void> {
    try {
      await action();
      if (successMsg) ToastService.show(successMsg, 'success');
    } catch {
      ToastService.show('Could not update moderation', 'error');
    }
  }

  /** Fetch any missing author profiles once, then re-render so real names replace placeholders. */
  private ensureAuthorNames(pubkeys: string[]): void {
    const profiles = UserProfileService.getInstance();
    const missing = pubkeys.filter(pk => !profiles.hasProfile(pk) && !this.requestedAuthors.has(pk));
    if (missing.length === 0) return;
    for (const pk of missing) this.requestedAuthors.add(pk);
    void Promise.all(missing.map(pk => profiles.getUserProfile(pk).catch(() => null)))
      .then(() => { if (!this.disposed) this.renderDhikrList(); });
  }

  /** Fill the year heading + table for the current `holidayYear` and clamp the nav buttons. */
  private renderHolidaysTable(): void {
    const slot = this.container.querySelector('[data-addon-content="holidays"]') as HTMLElement | null;
    if (!slot) return;
    const yearEl = slot.querySelector('[data-el="holiday-year"]') as HTMLElement | null;
    const tableEl = slot.querySelector('[data-el="holiday-table"]') as HTMLElement | null;
    if (!yearEl || !tableEl) return;

    const now = new Date();
    const minYear = now.getFullYear() - 3;
    const maxYear = now.getFullYear() + 10;
    this.holidayYear = Math.min(maxYear, Math.max(minYear, this.holidayYear));

    yearEl.textContent = `Holidays ${this.holidayYear}`;

    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    tableEl.innerHTML = getHolidaysForGregorianYear(this.holidayYear).map(h => {
      const past = h.date.getTime() < todayMid;
      return `<div class="ui-list__item${past ? ' is-past' : ''}"><span class="setting__label">${escapeHtml(h.name)}</span><span>${escapeHtml(formatDateByCalendar(h.date))}</span></div>`;
    }).join('');

    const prev = slot.querySelector('[data-action="prev-year"]') as HTMLButtonElement | null;
    const next = slot.querySelector('[data-action="next-year"]') as HTMLButtonElement | null;
    if (prev) prev.disabled = this.holidayYear <= minYear;
    if (next) next.disabled = this.holidayYear >= maxYear;
  }

  /** Build the panel section: Source dropdown + location picker + location heading + times. */
  private async renderPanel(): Promise<void> {
    const panel = this.container.querySelector('[data-el="panel"]') as HTMLElement | null;
    if (!panel) return;

    this.disposeDropdowns();
    this.sourceDD?.destroy(); this.sourceDD = null;

    const result = this.container.querySelector('[data-el="result"]') as HTMLElement | null;
    const source = getNostrMajlisSettings().source;
    panel.innerHTML = `
      <div class="setting"><span class="setting__label">Source</span><div class="setting__control" data-control="source"></div></div>
      <div data-el="picker"></div>
    `;
    if (result) result.innerHTML = `
      <h2 class="h4" data-el="location"></h2>
      <div data-el="times"></div>
      <div data-el="actions"></div>
    `;

    this.sourceDD = new CustomDropdown({
      options: SOURCE_OPTIONS,
      selectedValue: source,
      searchable: true,
      searchPlaceholder: 'Search source…',
      width: '100%',
      onChange: (value) => {
        setNostrMajlisSettings({ ...getNostrMajlisSettings(), source: value });
        void this.renderPanel();
      },
    });
    panel.querySelector('[data-control="source"]')?.appendChild(this.sourceDD.getElement());

    if (source === 'diyanet') await this.buildDiyanet();
    else await this.buildCalc(source);
  }

  private picker(): HTMLElement | null {
    return this.container.querySelector('[data-el="picker"]') as HTMLElement | null;
  }

  private optionList(places: { id: string; name: string }[], placeholder: string): DropdownOption[] {
    return [{ value: PICK, label: placeholder }, ...places.map(p => ({ value: p.id, label: p.name }))];
  }

  private renderTimes(timesEl: HTMLElement, t: ComputedTimes | DiyanetDayTimes | null): void {
    const times = t ?? ZERO;
    timesEl.innerHTML = `<div class="ui-list times">` + PRAYERS
      .map(([k, name]) => `<div class="ui-list__item"><span class="setting__label">${name}</span><span>${escapeHtml(times[k])}</span></div>`)
      .join('') + `</div>`;
  }

  private renderTimesPrompt(): void {
    const locEl = this.container.querySelector('[data-el="location"]') as HTMLElement | null;
    const timesEl = this.container.querySelector('[data-el="times"]') as HTMLElement | null;
    if (locEl) locEl.textContent = 'Select your location to see prayer times.';
    if (timesEl) timesEl.innerHTML = '';
  }

  // ---------- Diyanet ----------

  private async buildDiyanet(): Promise<void> {
    const token = ++this.renderToken;
    const picker = this.picker();
    if (picker) picker.innerHTML = `<p class="setting__desc pulsate">Loading…</p>`;

    let countries: DiyanetPlace[];
    try {
      countries = await DiyanetService.getInstance().getCountries();
    } catch {
      if (token === this.renderToken && picker) picker.innerHTML = `<p class="setting__desc">Could not reach the Diyanet service. Check your connection and reopen this page.</p>`;
      return;
    }
    if (this.stale(token) || !this.picker()) return;

    this.dCountries = countries;
    const loc = getNostrMajlisSettings().diyanetLocation;
    this.dUlke = loc?.ulkeId ?? PICK; this.dSehir = PICK; this.dIlce = PICK;
    this.dRegions = []; this.dDistricts = [];

    this.picker()!.innerHTML = `
      <div class="setting"><span class="setting__label">Country</span><div class="setting__control" data-control="d-country"></div></div>
      <div class="setting"><span class="setting__label">Region</span><div class="setting__control" data-control="d-region"></div></div>
      <div class="setting"><span class="setting__label">District</span><div class="setting__control" data-control="d-district"></div></div>
    `;
    const actions = this.container.querySelector('[data-el="actions"]') as HTMLElement | null;
    if (actions) actions.innerHTML = `<div class="l-row--right"><button class="btn btn--passive" data-action="fetch">Fetch Prayer Times</button></div>`;
    actions?.querySelector('[data-action="fetch"]')?.addEventListener('click', () => void this.onFetch());

    this.mountCtl('d-country', this.optionList(this.dCountries, 'Select country…'), this.dUlke, true, (v) => void this.onDCountry(v));
    this.mountCtl('d-region', this.optionList(this.dRegions, 'Select region…'), this.dSehir, false, (v) => void this.onDRegion(v));
    this.mountCtl('d-district', this.optionList(this.dDistricts, 'Select district…'), this.dIlce, false, (v) => void this.onDDistrict(v));

    if (loc) await this.restoreDiyanet(loc.sehirId, loc.ilceId, token);
    else this.renderTimesPrompt();
  }

  private mountCtl(control: string, options: DropdownOption[], selected: string, searchable: boolean, onChange: (v: string) => void): void {
    const host = this.container.querySelector(`[data-control="${control}"]`) as HTMLElement | null;
    if (!host) return;
    host.innerHTML = '';
    const dd = new CustomDropdown({ options, selectedValue: selected, searchable: searchable || options.length > 12, searchPlaceholder: 'Search…', width: '100%', onChange });
    this.dropdowns.push(dd);
    host.appendChild(dd.getElement());
  }

  private async restoreDiyanet(sehirId: string, ilceId: string, token: number): Promise<void> {
    try {
      this.dRegions = await DiyanetService.getInstance().getRegions(this.dUlke);
      if (this.stale(token)) return;
      this.dSehir = sehirId;
      this.mountCtl('d-region', this.optionList(this.dRegions, 'Select region…'), this.dSehir, false, (v) => void this.onDRegion(v));
      this.dDistricts = await DiyanetService.getInstance().getDistricts(sehirId);
      if (this.stale(token)) return;
      this.dIlce = ilceId;
      this.mountCtl('d-district', this.optionList(this.dDistricts, 'Select district…'), this.dIlce, false, (v) => void this.onDDistrict(v));
      await this.showDiyanetTimes(ilceId, token);
    } catch { this.renderTimesPrompt(); }
  }

  private async onDCountry(ulkeId: string): Promise<void> {
    this.dUlke = ulkeId; this.dSehir = PICK; this.dIlce = PICK; this.dRegions = []; this.dDistricts = [];
    this.clearDiyanetLocation();
    this.mountCtl('d-region', this.optionList([], 'Select region…'), PICK, false, (v) => void this.onDRegion(v));
    this.mountCtl('d-district', this.optionList([], 'Select district…'), PICK, false, (v) => void this.onDDistrict(v));
    this.renderTimesPrompt();
    if (ulkeId === PICK) return;
    const token = this.renderToken;
    try {
      this.dRegions = await DiyanetService.getInstance().getRegions(ulkeId);
      if (this.stale(token)) return;
      this.mountCtl('d-region', this.optionList(this.dRegions, 'Select region…'), PICK, false, (v) => void this.onDRegion(v));
    } catch { ToastService.show('Could not load regions', 'error'); }
  }

  private async onDRegion(sehirId: string): Promise<void> {
    this.dSehir = sehirId; this.dIlce = PICK; this.dDistricts = [];
    this.clearDiyanetLocation();
    this.mountCtl('d-district', this.optionList([], 'Select district…'), PICK, false, (v) => void this.onDDistrict(v));
    this.renderTimesPrompt();
    if (sehirId === PICK) return;
    const token = this.renderToken;
    try {
      this.dDistricts = await DiyanetService.getInstance().getDistricts(sehirId);
      if (this.stale(token)) return;
      this.mountCtl('d-district', this.optionList(this.dDistricts, 'Select district…'), PICK, false, (v) => void this.onDDistrict(v));
    } catch { ToastService.show('Could not load districts', 'error'); }
  }

  private async onDDistrict(ilceId: string): Promise<void> {
    this.dIlce = ilceId;
    if (ilceId === PICK) { this.clearDiyanetLocation(); this.renderTimesPrompt(); return; }
    const country = this.dCountries.find(c => c.id === this.dUlke)?.name ?? '';
    const region = this.dRegions.find(r => r.id === this.dSehir)?.name ?? '';
    const district = this.dDistricts.find(d => d.id === ilceId)?.name ?? '';
    const label = [district, region, country].filter(Boolean).join(', ');
    setNostrMajlisSettings({ ...getNostrMajlisSettings(), diyanetLocation: { ulkeId: this.dUlke, sehirId: this.dSehir, ilceId, label } });
    await this.showDiyanetTimes(ilceId, this.renderToken);
  }

  private clearDiyanetLocation(): void {
    setNostrMajlisSettings({ ...getNostrMajlisSettings(), diyanetLocation: null });
  }

  private async showDiyanetTimes(ilceId: string, token: number): Promise<void> {
    const locEl = this.container.querySelector('[data-el="location"]') as HTMLElement | null;
    const timesEl = this.container.querySelector('[data-el="times"]') as HTMLElement | null;
    if (!locEl || !timesEl) return;
    const label = getNostrMajlisSettings().diyanetLocation?.label ?? '';
    const svc = DiyanetService.getInstance();

    let today = svc.cachedToday(ilceId);
    if (!today && svc.cachedRows(ilceId).length === 0) {
      locEl.textContent = label;
      timesEl.innerHTML = `<p class="setting__desc pulsate">Fetching times…</p>`;
      try { await svc.fetchAndCacheTimes(ilceId); } catch { /* fall through to 00:00 */ }
      if (this.stale(token)) return;
      today = svc.cachedToday(ilceId);
    }
    locEl.textContent = today ? `${label} — ${today.date}` : `${label} — no times cached, tap “Fetch Prayer Times”`;
    this.renderTimes(timesEl, today);
  }

  private async onFetch(): Promise<void> {
    if (this.dIlce === PICK) { ToastService.show('Pick a district first', 'error'); return; }
    const btn = this.container.querySelector('[data-action="fetch"]') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; btn.classList.add('pulsate'); }
    try {
      await DiyanetService.getInstance().fetchAndCacheTimes(this.dIlce);
      await this.showDiyanetTimes(this.dIlce, this.renderToken);
      ToastService.show('Prayer times updated', 'success');
    } catch {
      ToastService.show('Could not fetch prayer times', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Fetch Prayer Times'; btn.classList.remove('pulsate'); }
    }
  }

  // ---------- Calculation (GeoNames + adhan) ----------

  private async buildCalc(method: string): Promise<void> {
    const token = ++this.renderToken;
    const picker = this.picker();
    if (picker) picker.innerHTML = `<p class="setting__desc pulsate">Loading…</p>`;
    let data: CityData;
    try { data = await loadCityData(); } catch { if (token === this.renderToken && picker) picker.innerHTML = `<p class="setting__desc">Could not load city data.</p>`; return; }
    if (this.stale(token) || !this.picker()) return;

    this.cityData = data;
    const settings = getNostrMajlisSettings();
    this.gCc = settings.calcCity?.cc ?? PICK;
    this.gA1 = settings.calcCity ? (settings.calcCity.a1 || '') : PICK;

    const actions = this.container.querySelector('[data-el="actions"]') as HTMLElement | null;
    if (actions) actions.innerHTML = ''; // no fetch button for calc

    this.picker()!.innerHTML = `
      <div class="setting"><span class="setting__label">Country</span><div class="setting__control" data-control="g-country"></div></div>
      <div class="setting"><span class="setting__label">Region</span><div class="setting__control" data-control="g-region"></div></div>
      <div class="setting"><span class="setting__label">City</span><div class="setting__control" data-control="g-city"></div></div>
      <div class="setting"><span class="setting__label">Asr madhab</span><div class="setting__control" data-control="g-madhab"></div></div>
    `;
    this.mountCtl('g-country', this.optionList(data.countries.map(([id, name]) => ({ id, name })), 'Select country…'), this.gCc, true, (v) => this.onGCountry(method, v));
    this.mountGRegion(method);
    this.mountGCity(method);
    this.mountGMadhab(method);
    this.updateCalcTimes(method);
  }

  private mountGRegion(method: string): void {
    const opts: DropdownOption[] = [{ value: PICK, label: 'Select region…' }];
    if (this.cityData && this.gCc !== PICK) opts.push(...regionOptions(this.cityData, this.gCc));
    this.mountCtl('g-region', opts, this.gA1, false, (v) => this.onGRegion(method, v));
  }

  private mountGCity(method: string): void {
    const ready = this.cityData && this.gCc !== PICK && this.gA1 !== PICK;
    const opts: DropdownOption[] = [{ value: PICK, label: 'Select city…' }];
    let selected = PICK;
    if (ready) {
      opts.push(...cityOptions(this.cityData!, this.gCc, this.gA1));
      const saved = getNostrMajlisSettings().calcCity;
      if (saved && saved.cc === this.gCc && (saved.a1 || '') === this.gA1) {
        const idx = this.cityData!.cities.findIndex(c => c[1] === saved.cc && (c[2] || '') === this.gA1 && c[0] === saved.name && c[3] === saved.lat && c[4] === saved.lng);
        if (idx >= 0) selected = String(idx);
      }
    }
    this.mountCtl('g-city', opts, selected, !!ready, (v) => this.onGCity(method, v));
  }

  private mountGMadhab(method: string): void {
    this.mountCtl('g-madhab', MADHAB_OPTIONS, getNostrMajlisSettings().madhab, false, (v) => {
      setNostrMajlisSettings({ ...getNostrMajlisSettings(), madhab: v === 'hanafi' ? 'hanafi' : 'shafi' });
      this.updateCalcTimes(method);
    });
  }

  private onGCountry(method: string, cc: string): void {
    this.gCc = cc; this.gA1 = PICK;
    setNostrMajlisSettings({ ...getNostrMajlisSettings(), calcCity: null });
    this.mountGRegion(method);
    this.mountGCity(method);
    this.updateCalcTimes(method);
  }

  private onGRegion(method: string, a1: string): void {
    this.gA1 = a1;
    setNostrMajlisSettings({ ...getNostrMajlisSettings(), calcCity: null });
    this.mountGCity(method);
    this.updateCalcTimes(method);
  }

  private onGCity(method: string, value: string): void {
    if (value === PICK || !this.cityData) {
      setNostrMajlisSettings({ ...getNostrMajlisSettings(), calcCity: null });
    } else {
      const city = resolveCity(this.cityData, parseInt(value, 10));
      setNostrMajlisSettings({ ...getNostrMajlisSettings(), calcCity: city });
    }
    this.updateCalcTimes(method);
  }

  private updateCalcTimes(method: string): void {
    const locEl = this.container.querySelector('[data-el="location"]') as HTMLElement | null;
    const timesEl = this.container.querySelector('[data-el="times"]') as HTMLElement | null;
    if (!locEl || !timesEl) return;
    const s = getNostrMajlisSettings();
    if (!s.calcCity) { locEl.textContent = 'Select your city to see prayer times.'; timesEl.innerHTML = ''; return; }
    locEl.textContent = s.calcCity.label;
    this.renderTimes(timesEl, computeTimes(s.calcCity, method, s.madhab));
  }

  // ---------- Reminders ----------

  private renderReminders(): void {
    const host = this.container.querySelector('[data-el="reminders"]') as HTMLElement | null;
    if (!host) return;
    this.disposeReminders();

    const r = getNostrMajlisSettings().reminders;
    this.masterSwitch = new Switch({
      label: '',
      checked: r.enabled,
      onChange: (c) => {
        const s = getNostrMajlisSettings();
        setNostrMajlisSettings({ ...s, reminders: { ...s.reminders, enabled: c } });
        this.renderReminders();
      },
    });

    let html = `<h2 class="h4">Reminder Settings</h2><div class="setting"><span class="setting__label">Prayer reminders</span><div class="setting__control">${this.masterSwitch.render()}</div><p class="setting__desc">Shows a banner before each prayer while NoorNote is open.</p></div>`;
    if (r.enabled) {
      html += `<div class="setting"><span class="setting__label">Minutes before</span><div class="setting__control" data-control="offset"></div></div>`;
      for (const [key, name] of REMINDER_PRAYERS) {
        const sw = new Switch({
          label: '',
          checked: r.prayers[key],
          onChange: (c) => {
            const s = getNostrMajlisSettings();
            setNostrMajlisSettings({ ...s, reminders: { ...s.reminders, prayers: { ...s.reminders.prayers, [key]: c } } });
          },
        });
        this.praySwitches.push(sw);
        html += `<div class="setting"><span class="setting__label">${name}</span><div class="setting__control">${sw.render()}</div></div>`;
      }
    }
    host.innerHTML = html;
    this.masterSwitch.setupEventListeners(host);

    if (r.enabled) {
      this.offsetDD = new CustomDropdown({
        options: [5, 10, 15, 20, 30, 45, 60].map(n => ({ value: String(n), label: `${n} min` })),
        selectedValue: String(r.offsetMin),
        width: '100%',
        onChange: (v) => {
          const s = getNostrMajlisSettings();
          setNostrMajlisSettings({ ...s, reminders: { ...s.reminders, offsetMin: parseInt(v, 10) } });
        },
      });
      host.querySelector('[data-control="offset"]')?.appendChild(this.offsetDD.getElement());
      for (const sw of this.praySwitches) sw.setupEventListeners(host);
    }
  }

  private disposeReminders(): void {
    this.offsetDD?.destroy(); this.offsetDD = null;
    this.masterSwitch?.destroy(); this.masterSwitch = null;
    for (const sw of this.praySwitches) sw.destroy();
    this.praySwitches = [];
  }

  private disposeDropdowns(): void {
    for (const dd of this.dropdowns) dd.destroy();
    this.dropdowns = [];
  }

  public getElement(): HTMLElement { return this.container; }

  public destroy(): void {
    this.disposed = true;
    if (this.calendarSubId) { TypedEventBus.getInstance().off(this.calendarSubId); this.calendarSubId = null; }
    if (this.dhikrBusSub) { TypedEventBus.getInstance().off(this.dhikrBusSub); this.dhikrBusSub = null; }
    this.disposeDropdowns();
    this.disposeReminders();
    this.disposeHolidayReminders();
    this.widgetSwitch?.destroy(); this.widgetSwitch = null;
    this.sourceDD?.destroy(); this.sourceDD = null;
    this.enableSwitch?.destroy(); this.enableSwitch = null;
    this.notifySwitch?.destroy(); this.notifySwitch = null;
    this.container.innerHTML = '';
  }
}
