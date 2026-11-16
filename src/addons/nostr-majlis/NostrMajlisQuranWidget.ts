/**
 * NostrMajlisQuranWidget — the daily ayah as its OWN widget (v1 + v2).
 *
 * The ayah used to live INSIDE the prayer-times widget; both UIs now render
 * it as a separate widget: classic mounts into
 * `[data-sidebar-widget="nostr-majlis-quran"]` (MainLayout, right after the
 * prayer-times widget), the Focus UI stage re-parents it into its
 * side-stack slot via setFocusHost. Markup: translation (clamped), source
 * reference, "Show tafsir" deep-link. Day-cached via getDailyAyah;
 * re-renders on the settings bus (the quranDaily switch flipped in the
 * addon object).
 *
 * Shows NOTHING when the quranDaily setting is off (empty classic container
 * / empty stage slot hides via :has, same as the other widgets).
 */

import { getNostrMajlisSettings } from './index';
import {
  dateKeyOf,
  getDailyAyah,
  truncateText,
  WIDGET_TRANSLATION_MAX,
  type DailyAyah,
} from './quranDaily';
import { TypedEventBus } from '../../core/TypedEventBus';
import { Router } from '../../services/Router';
import { escapeHtml } from '../../helpers/escapeHtml';
import { _ } from '../../i18n';

export class NostrMajlisQuranWidget {
  private el: HTMLElement | null = null;
  /**
   * Focus UI (v2) host: when set, the widget renders into the stage's
   * side-stack slot. null = classic slot (see mount()).
   */
  private focusHost: HTMLElement | null = null;
  private subId: string | null = null;
  private destroyed = false;
  /** Ayah state survives re-renders; the fetch itself is day-cached. */
  private ayah: DailyAyah | null = null;
  private dateKey = '';
  private loading = false;

  // Delegated so it survives the innerHTML rewrites; removed in destroy().
  // The app does not intercept raw anchors → SPA-navigate the "Show tafsir"
  // deep-link ourselves (same pattern as NostrMajlisSidebarWidget.onClick).
  private onClick = (e: MouseEvent): void => {
    const link = (e.target as HTMLElement | null)?.closest('a');
    if (!link) return;
    e.preventDefault();
    Router.getInstance().navigate(link.getAttribute('href') ?? '');
  };

  constructor() {
    this.subId = TypedEventBus.getInstance().on(
      'nostr-majlis:settings-changed',
      () => void this.render()
    );
  }

  /** Classic: find the sidebar slot and render according to the setting. */
  public mount(): void {
    void this.render();
  }

  /**
   * Focus UI (v2): render into the stage's side-stack slot while it
   * exists (null on stack teardown — the widget returns to the classic
   * slot). The next render re-parents the DOM.
   */
  public setFocusHost(host: HTMLElement | null): void {
    this.focusHost = host;
    if (this.el && this.el.parentElement !== host) {
      this.el.remove();
      this.el = null;
    }
    void this.render();
  }

  private async render(): Promise<void> {
    if (this.destroyed) return;
    const host =
      this.focusHost ??
      document.querySelector('[data-sidebar-widget="nostr-majlis-quran"]');
    if (!host || !getNostrMajlisSettings().quranDaily) {
      this.el?.removeEventListener('click', this.onClick);
      this.el?.remove();
      this.el = null;
      return;
    }

    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'sidebar-widget nm-quran-widget';
      this.el.addEventListener('click', this.onClick);
    }
    if (this.el.parentElement !== host) {
      host.appendChild(this.el);
    }
    await this.update();
  }

  private async update(): Promise<void> {
    if (!this.el) return;
    const today = dateKeyOf(new Date());
    if (!this.ayah || this.dateKey !== today) {
      if (!this.loading) {
        this.el.innerHTML = `<div class="nm-quran__loading pulsate">${_('Loading the daily ayah…')}</div>`;
        this.loading = true;
        try {
          const ayah = await getDailyAyah();
          if (ayah) {
            this.ayah = ayah;
            this.dateKey = today;
          }
        } finally {
          this.loading = false;
        }
      }
      if (!this.ayah) {
        if (this.el) {
          this.el.innerHTML = `<div class="nm-quran__loading${this.loading ? ' pulsate' : ''}">${this.loading ? _('Loading the daily ayah…') : _('Daily ayah unavailable, will retry tomorrow.')}</div>`;
        }
        return;
      }
    }
    this.renderAyah();
  }

  private renderAyah(): void {
    if (!this.el || !this.ayah) return;
    const a = this.ayah;
    const ref = `[${a.surah}:${a.ayah}]`;
    this.el.innerHTML = `
      ${a.english ? `<p class="nm-quran__translation nm-quran__translation--clamp">${escapeHtml(truncateText(a.english, WIDGET_TRANSLATION_MAX))}</p>` : ''}
      <div class="l-row--split">
        <div>${a.tafsir ? `<a class="nm-quran__hint" href="/addons/nostr-majlis/daily-ayah">${_('Show tafsir')}</a>` : ''}</div>
        <div><span class="nm-quran__ref-line">${escapeHtml(ref)}</span></div>
      </div>
    `;
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.subId) {
      TypedEventBus.getInstance().off(this.subId);
      this.subId = null;
    }
    this.el?.removeEventListener('click', this.onClick);
    this.el?.remove();
    this.el = null;
    this.focusHost = null;
  }
}
