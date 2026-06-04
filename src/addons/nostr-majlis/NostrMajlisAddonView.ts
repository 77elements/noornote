/**
 * NostrMajlisAddonView - settings page + inline Salah panel (route `/addons/nostr-majlis`).
 *
 * Toggle (emits `nostr-majlis:addon-toggle`). When enabled: a Source dropdown selects either
 *  - Diyanet (official, online): Diyanet's Country->Region->District list, official times
 *    fetched + persistently cached; a "Fetch Prayer Times" button appends the next ~30 days.
 *  - a calculation method (MWL, ISNA, …): GeoNames Country->Region->City + Asr madhab,
 *    computed locally (offline).
 * Selection (source + per-source location) persists across reloads. Reminders (S3/S4),
 * holidays (M2) and dhikr (M3) follow. See docs/todos/muslims-addon.md.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { CustomDropdown, type DropdownOption } from '../../components/ui/CustomDropdown';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { escapeHtml } from '../../helpers/escapeHtml';
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

export class NostrMajlisAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private sourceDD: CustomDropdown | null = null;
  private dropdowns: CustomDropdown[] = []; // panel dropdowns, disposed on panel switch

  // Reminder controls
  private masterSwitch: Switch | null = null;
  private offsetDD: CustomDropdown | null = null;
  private praySwitches: Switch[] = [];

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

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-nostr-majlis';
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
      <div data-addon-content="salah"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    void this.renderSalah();
  }

  private stale(token: number): boolean {
    return this.disposed || token !== this.renderToken || !isNostrMajlisEnabled();
  }

  private renderSalah(): void {
    const slot = this.container.querySelector('[data-addon-content="salah"]') as HTMLElement | null;
    if (!slot) return;

    this.disposeDropdowns();
    this.disposeReminders();
    this.sourceDD?.destroy(); this.sourceDD = null;

    if (!isNostrMajlisEnabled()) { slot.innerHTML = ''; return; }

    slot.innerHTML = `
      <section class="section">
        <div class="setting"><span class="setting__label">Source</span><div class="setting__control" data-control="source"></div></div>
      </section>
      <div data-el="panel"></div>
      <section class="section" data-el="reminders"></section>
    `;

    this.sourceDD = new CustomDropdown({
      options: SOURCE_OPTIONS,
      selectedValue: getNostrMajlisSettings().source,
      searchable: true,
      searchPlaceholder: 'Search source…',
      width: '100%',
      onChange: (value) => {
        setNostrMajlisSettings({ ...getNostrMajlisSettings(), source: value });
        void this.renderPanel();
      },
    });
    slot.querySelector('[data-control="source"]')?.appendChild(this.sourceDD.getElement());

    void this.renderPanel();
    this.renderReminders();
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

    let html = `<div class="setting"><span class="setting__label">Prayer reminders</span><div class="setting__control">${this.masterSwitch.render()}</div><p class="setting__desc">Shows a banner before each prayer while NoorNote is open.</p></div>`;
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

  private async renderPanel(): Promise<void> {
    const panel = this.container.querySelector('[data-el="panel"]') as HTMLElement | null;
    if (!panel) return;
    this.disposeDropdowns();
    const source = getNostrMajlisSettings().source;
    if (source === 'diyanet') await this.renderDiyanetPanel(panel);
    else await this.renderCalcPanel(panel, source);
  }

  // ---------- shared ----------

  private optionList(places: { id: string; name: string }[], placeholder: string): DropdownOption[] {
    return [{ value: PICK, label: placeholder }, ...places.map(p => ({ value: p.id, label: p.name }))];
  }

  private renderTimes(timesEl: HTMLElement, t: ComputedTimes | DiyanetDayTimes | null): void {
    const times = t ?? ZERO;
    timesEl.innerHTML = PRAYERS
      .map(([k, name]) => `<div class="setting"><span class="setting__label">${name}</span><div class="setting__control">${escapeHtml(times[k])}</div></div>`)
      .join('');
  }

  // ---------- Diyanet panel ----------

  private async renderDiyanetPanel(panel: HTMLElement): Promise<void> {
    const token = ++this.renderToken;
    panel.innerHTML = `<p class="setting__desc pulsate">Loading…</p>`;
    let countries: DiyanetPlace[];
    try {
      countries = await DiyanetService.getInstance().getCountries();
    } catch {
      if (token === this.renderToken) panel.innerHTML = `<p class="setting__desc">Could not reach the Diyanet service. Check your connection and reopen this page.</p>`;
      return;
    }
    if (this.stale(token)) return;

    this.dCountries = countries;
    const loc = getNostrMajlisSettings().diyanetLocation;
    this.dUlke = loc?.ulkeId ?? PICK; this.dSehir = PICK; this.dIlce = PICK;
    this.dRegions = []; this.dDistricts = [];

    panel.innerHTML = `
      <section class="section">
        <div class="setting"><span class="setting__label">Country</span><div class="setting__control" data-control="d-country"></div></div>
        <div class="setting"><span class="setting__label">Region</span><div class="setting__control" data-control="d-region"></div></div>
        <div class="setting"><span class="setting__label">District</span><div class="setting__control" data-control="d-district"></div></div>
      </section>
      <section class="section">
        <p class="setting__desc" data-el="location"></p>
        <div data-el="times"></div>
        <div class="l-row--right"><button class="btn btn--passive btn--medium" data-action="fetch">Fetch Prayer Times</button></div>
      </section>
    `;
    this.mountDiyanet(panel, 'd-country', this.optionList(this.dCountries, 'Select country…'), this.dUlke, true, (v) => void this.onDCountry(panel, v));
    this.mountDiyanet(panel, 'd-region', this.optionList(this.dRegions, 'Select region…'), this.dSehir, false, (v) => void this.onDRegion(panel, v));
    this.mountDiyanet(panel, 'd-district', this.optionList(this.dDistricts, 'Select district…'), this.dIlce, false, (v) => void this.onDDistrict(v));
    panel.querySelector('[data-action="fetch"]')?.addEventListener('click', () => void this.onFetch(panel));

    if (loc) await this.restoreDiyanet(panel, loc.sehirId, loc.ilceId, token);
    else this.renderTimesPrompt();
  }

  private mountDiyanet(panel: HTMLElement, control: string, options: DropdownOption[], selected: string, searchable: boolean, onChange: (v: string) => void): void {
    const dd = new CustomDropdown({ options, selectedValue: selected, searchable: searchable || options.length > 12, searchPlaceholder: 'Search…', width: '100%', onChange });
    this.dropdowns.push(dd);
    panel.querySelector(`[data-control="${control}"]`)?.appendChild(dd.getElement());
  }

  private async restoreDiyanet(panel: HTMLElement, sehirId: string, ilceId: string, token: number): Promise<void> {
    try {
      this.dRegions = await DiyanetService.getInstance().getRegions(this.dUlke);
      if (this.stale(token)) return;
      this.dSehir = sehirId;
      this.remountDiyanet(panel, 'd-region', this.dRegions, this.dSehir, (v) => void this.onDRegion(panel, v));
      this.dDistricts = await DiyanetService.getInstance().getDistricts(sehirId);
      if (this.stale(token)) return;
      this.dIlce = ilceId;
      this.remountDiyanet(panel, 'd-district', this.dDistricts, this.dIlce, (v) => void this.onDDistrict(v));
      await this.showDiyanetTimes(ilceId, token);
    } catch { this.renderTimesPrompt(); }
  }

  private remountDiyanet(panel: HTMLElement, control: string, places: DiyanetPlace[], selected: string, onChange: (v: string) => void): void {
    const host = panel.querySelector(`[data-control="${control}"]`) as HTMLElement | null;
    if (host) host.innerHTML = '';
    this.mountDiyanet(panel, control, this.optionList(places, 'Select…'), selected, false, onChange);
  }

  private async onDCountry(panel: HTMLElement, ulkeId: string): Promise<void> {
    this.dUlke = ulkeId; this.dSehir = PICK; this.dIlce = PICK; this.dRegions = []; this.dDistricts = [];
    this.clearDiyanetLocation();
    this.remountDiyanet(panel, 'd-region', [], PICK, (v) => void this.onDRegion(panel, v));
    this.remountDiyanet(panel, 'd-district', [], PICK, (v) => void this.onDDistrict(v));
    this.renderTimesPrompt();
    if (ulkeId === PICK) return;
    const token = this.renderToken;
    try {
      this.dRegions = await DiyanetService.getInstance().getRegions(ulkeId);
      if (this.stale(token)) return;
      this.remountDiyanet(panel, 'd-region', this.dRegions, PICK, (v) => void this.onDRegion(panel, v));
    } catch { ToastService.show('Could not load regions', 'error'); }
  }

  private async onDRegion(panel: HTMLElement, sehirId: string): Promise<void> {
    this.dSehir = sehirId; this.dIlce = PICK; this.dDistricts = [];
    this.clearDiyanetLocation();
    this.remountDiyanet(panel, 'd-district', [], PICK, (v) => void this.onDDistrict(v));
    this.renderTimesPrompt();
    if (sehirId === PICK) return;
    const token = this.renderToken;
    try {
      this.dDistricts = await DiyanetService.getInstance().getDistricts(sehirId);
      if (this.stale(token)) return;
      this.remountDiyanet(panel, 'd-district', this.dDistricts, PICK, (v) => void this.onDDistrict(v));
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
      // First time for this district → fetch once automatically.
      locEl.textContent = label;
      timesEl.innerHTML = `<p class="setting__desc pulsate">Fetching times…</p>`;
      try { await svc.fetchAndCacheTimes(ilceId); } catch { /* fall through to 00:00 */ }
      if (this.stale(token)) return;
      today = svc.cachedToday(ilceId);
    }
    locEl.textContent = today ? `${label} — ${today.date}` : `${label} — no times cached, tap “Fetch Prayer Times”`;
    this.renderTimes(timesEl, today);
  }

  private async onFetch(panel: HTMLElement): Promise<void> {
    if (this.dIlce === PICK) { ToastService.show('Pick a district first', 'error'); return; }
    const btn = panel.querySelector('[data-action="fetch"]') as HTMLButtonElement | null;
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

  // ---------- Calculation panel (GeoNames + adhan) ----------

  private async renderCalcPanel(panel: HTMLElement, method: string): Promise<void> {
    const token = ++this.renderToken;
    panel.innerHTML = `<p class="setting__desc pulsate">Loading…</p>`;
    let data: CityData;
    try { data = await loadCityData(); } catch { if (token === this.renderToken) panel.innerHTML = `<p class="setting__desc">Could not load city data.</p>`; return; }
    if (this.stale(token)) return;

    this.cityData = data;
    const settings = getNostrMajlisSettings();
    this.gCc = settings.calcCity?.cc ?? PICK;
    this.gA1 = settings.calcCity ? (settings.calcCity.a1 || '') : PICK;

    panel.innerHTML = `
      <section class="section">
        <div class="setting"><span class="setting__label">Country</span><div class="setting__control" data-control="g-country"></div></div>
        <div class="setting"><span class="setting__label">Region</span><div class="setting__control" data-control="g-region"></div></div>
        <div class="setting"><span class="setting__label">City</span><div class="setting__control" data-control="g-city"></div></div>
        <div class="setting"><span class="setting__label">Asr madhab</span><div class="setting__control" data-control="g-madhab"></div></div>
      </section>
      <section class="section">
        <p class="setting__desc" data-el="location"></p>
        <div data-el="times"></div>
      </section>
    `;
    this.mountG(panel, 'g-country', this.optionList(data.countries.map(([id, name]) => ({ id, name })), 'Select country…'), this.gCc, true, (v) => this.onGCountry(panel, method, v));
    this.mountGRegion(panel, method);
    this.mountGCity(panel, method);
    this.mountGMadhab(panel, method);
    this.updateCalcTimes(method);
  }

  private mountG(panel: HTMLElement, control: string, options: DropdownOption[], selected: string, searchable: boolean, onChange: (v: string) => void): void {
    const host = panel.querySelector(`[data-control="${control}"]`) as HTMLElement | null;
    if (host) host.innerHTML = '';
    const dd = new CustomDropdown({ options, selectedValue: selected, searchable: searchable || options.length > 12, searchPlaceholder: 'Search…', width: '100%', onChange });
    this.dropdowns.push(dd);
    host?.appendChild(dd.getElement());
  }

  private mountGRegion(panel: HTMLElement, method: string): void {
    const opts: DropdownOption[] = [{ value: PICK, label: 'Select region…' }];
    if (this.cityData && this.gCc !== PICK) opts.push(...regionOptions(this.cityData, this.gCc));
    this.mountG(panel, 'g-region', opts, this.gA1, false, (v) => this.onGRegion(panel, method, v));
  }

  private mountGCity(panel: HTMLElement, method: string): void {
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
    this.mountG(panel, 'g-city', opts, selected, !!ready, (v) => this.onGCity(method, v));
  }

  private mountGMadhab(panel: HTMLElement, method: string): void {
    this.mountG(panel, 'g-madhab', MADHAB_OPTIONS, getNostrMajlisSettings().madhab, false, (v) => {
      setNostrMajlisSettings({ ...getNostrMajlisSettings(), madhab: v === 'hanafi' ? 'hanafi' : 'shafi' });
      this.updateCalcTimes(method);
    });
  }

  private onGCountry(panel: HTMLElement, method: string, cc: string): void {
    this.gCc = cc; this.gA1 = PICK;
    setNostrMajlisSettings({ ...getNostrMajlisSettings(), calcCity: null });
    this.mountGRegion(panel, method);
    this.mountGCity(panel, method);
    this.updateCalcTimes(method);
  }

  private onGRegion(panel: HTMLElement, method: string, a1: string): void {
    this.gA1 = a1;
    setNostrMajlisSettings({ ...getNostrMajlisSettings(), calcCity: null });
    this.mountGCity(panel, method);
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

  // ---------- shared times helpers ----------

  private renderTimesPrompt(): void {
    const locEl = this.container.querySelector('[data-el="location"]') as HTMLElement | null;
    const timesEl = this.container.querySelector('[data-el="times"]') as HTMLElement | null;
    if (locEl) locEl.textContent = 'Select your location to see prayer times.';
    if (timesEl) timesEl.innerHTML = '';
  }

  private disposeDropdowns(): void {
    for (const dd of this.dropdowns) dd.destroy();
    this.dropdowns = [];
  }

  public getElement(): HTMLElement { return this.container; }

  public destroy(): void {
    this.disposed = true;
    this.disposeDropdowns();
    this.disposeReminders();
    this.sourceDD?.destroy(); this.sourceDD = null;
    this.enableSwitch?.destroy(); this.enableSwitch = null;
    this.container.innerHTML = '';
  }
}
