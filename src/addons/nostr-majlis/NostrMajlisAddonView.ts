/**
 * NostrMajlisAddonView - settings page + inline Salah panel (route `/addons/nostr-majlis`).
 *
 * S1: toggle (emits `nostr-majlis:addon-toggle`) + when enabled, a method/madhab picker
 * and today's prayer times for the test location. City picker (S2), reminders (S3/S4),
 * holidays (M2) and dhikr (M3) follow. See docs/todos/muslims-addon.md.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { CustomDropdown, type DropdownOption } from '../../components/ui/CustomDropdown';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { escapeHtml } from '../../helpers/escapeHtml';
import {
  isNostrMajlisEnabled,
  setNostrMajlisEnabled,
  getNostrMajlisSettings,
  setNostrMajlisSettings,
} from './index';
import { SalahService } from './SalahService';

const METHOD_OPTIONS: DropdownOption[] = [
  { value: 'MuslimWorldLeague', label: 'Muslim World League' },
  { value: 'Turkey', label: 'Diyanet (Turkey)' },
  { value: 'NorthAmerica', label: 'ISNA (North America)' },
  { value: 'Egyptian', label: 'Egyptian General Authority' },
  { value: 'UmmAlQura', label: 'Umm al-Qura (Makkah)' },
  { value: 'Karachi', label: 'Karachi' },
  { value: 'Tehran', label: 'Tehran (Jafari)' },
  { value: 'Dubai', label: 'Dubai' },
  { value: 'Kuwait', label: 'Kuwait' },
  { value: 'Qatar', label: 'Qatar' },
  { value: 'Singapore', label: 'Singapore (MUIS)' },
  { value: 'MoonsightingCommittee', label: 'Moonsighting Committee' },
];

const MADHAB_OPTIONS: DropdownOption[] = [
  { value: 'shafi', label: 'Standard (Shafi / Maliki / Hanbali)' },
  { value: 'hanafi', label: 'Hanafi' },
];

export class NostrMajlisAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private methodDropdown: CustomDropdown | null = null;
  private madhabDropdown: CustomDropdown | null = null;

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
        this.renderSalah();
      },
    });

    this.container.innerHTML = `
      <h1>Nostr-Majlis</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Nostr-Majlis</span>
          <div class="setting__control">${this.enableSwitch.render()}</div>
          <p class="setting__desc">Islamic features for NoorNote: prayer times (Salah), Islamic holidays, and community dhikr. Prayer times are calculated locally on your device — no location ever leaves it.</p>
        </div>
      </section>
      <div data-addon-content="salah"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    this.renderSalah();
  }

  /** Build the Salah panel (method/madhab dropdowns + today's times) inline when enabled. */
  private renderSalah(): void {
    const slot = this.container.querySelector('[data-addon-content="salah"]') as HTMLElement | null;
    if (!slot) return;

    this.disposeDropdowns();

    if (!isNostrMajlisEnabled()) {
      slot.innerHTML = '';
      return;
    }

    const settings = getNostrMajlisSettings();

    slot.innerHTML = `
      <section class="section">
        <div class="setting">
          <span class="setting__label">Calculation method</span>
          <div class="setting__control" data-control="method"></div>
        </div>
        <div class="setting">
          <span class="setting__label">Asr madhab</span>
          <div class="setting__control" data-control="madhab"></div>
        </div>
      </section>
      <section class="section">
        <p class="setting__desc" data-el="location"></p>
        <div data-el="times"></div>
      </section>
    `;

    const locEl = slot.querySelector('[data-el="location"]') as HTMLElement | null;
    if (locEl) locEl.textContent = SalahService.getInstance().location.label;

    this.methodDropdown = new CustomDropdown({
      options: METHOD_OPTIONS,
      selectedValue: settings.method,
      onChange: (value) => {
        setNostrMajlisSettings({ ...getNostrMajlisSettings(), method: value });
        this.updateTimes();
      },
    });
    slot.querySelector('[data-control="method"]')?.appendChild(this.methodDropdown.getElement());

    this.madhabDropdown = new CustomDropdown({
      options: MADHAB_OPTIONS,
      selectedValue: settings.madhab,
      onChange: (value) => {
        setNostrMajlisSettings({ ...getNostrMajlisSettings(), madhab: value === 'hanafi' ? 'hanafi' : 'shafi' });
        this.updateTimes();
      },
    });
    slot.querySelector('[data-control="madhab"]')?.appendChild(this.madhabDropdown.getElement());

    this.updateTimes();
  }

  /** Recompute + render today's times (called on mount and on method/madhab change). */
  private updateTimes(): void {
    const timesEl = this.container.querySelector('[data-el="times"]') as HTMLElement | null;
    if (!timesEl) return;

    const times = SalahService.getInstance().computeTimes();
    const fmt = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    timesEl.innerHTML = times
      .map(t => `<div class="setting"><span class="setting__label">${escapeHtml(t.name)}</span><div class="setting__control">${fmt(t.time)}</div></div>`)
      .join('');
  }

  private disposeDropdowns(): void {
    this.methodDropdown?.destroy();
    this.methodDropdown = null;
    this.madhabDropdown?.destroy();
    this.madhabDropdown = null;
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.disposeDropdowns();
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.container.innerHTML = '';
  }
}
