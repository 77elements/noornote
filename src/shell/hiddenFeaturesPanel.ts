/**
 * Hidden Features panel (v2) — the ED-b section that collects hidden
 * object circles in a compact, restorable form (docs/todos/hidden-
 * objects.md). Mounted by the stage when the ED-b is opened via its tab
 * (no per-object settings panel active): no full circles here, just a
 * grid of one-liner chips (object name + one Unhide button each, the FV
 * widget-button pattern). Unhide restores the circle to its stored order
 * position and re-creates its surface lazily — hiding is never a one-way
 * ticket.
 */

import { FOCUS_DOMAINS, type FocusSettingsView } from './focusDomains';
import {
  loadHiddenObjectIds,
  saveHiddenObjectIds,
  unhideObject,
} from './hiddenObjectsStore';
import { TypedEventBus } from '../core/TypedEventBus';
import { _ } from '../i18n';

export class HiddenFeaturesPanel implements FocusSettingsView {
  /** focus:objects-hidden-changed subscription (mount → destroy contract). */
  private subId: string | null = null;
  private el: HTMLElement | null = null;
  private grid: HTMLElement | null = null;

  mount(el: HTMLElement): void {
    this.el = el;
    el.innerHTML = `
      <div class="hidden-features">
        <div class="hidden-features__head">
          <h3 class="hidden-features__heading">${_('Hidden Features')}</h3>
          <span class="hidden-features__head-link" data-unhide-all-slot></span>
        </div>
        <div class="hidden-features__grid" data-hidden-grid></div>
      </div>
    `;
    this.grid = el.querySelector('[data-hidden-grid]') as HTMLElement;
    // Delegated on the mounted root (survives re-renders of the slot/grid).
    el.addEventListener('click', this.onClick);
    this.render();
    // Live: a chip's Unhide (or any other hide/unhide) re-renders the grid.
    this.subId = TypedEventBus.getInstance().on(
      'focus:objects-hidden-changed',
      () => this.render()
    );
  }

  private onClick = (e: MouseEvent): void => {
    if (!(e.target as HTMLElement | null)?.closest('[data-unhide-all]')) return;
    e.preventDefault(); // plain <a href="#"> — no navigation jump
    e.stopPropagation();
    // One save → one event → applyDomainShutdown diffs the whole set and
    // fresh-starts every domain through the regular unhide code path.
    saveHiddenObjectIds([]);
  };

  private render(): void {
    if (!this.grid || !this.el) return;
    const hidden = loadHiddenObjectIds();
    // "Unhide all" only earns its place with two or more hidden objects —
    // a single one is one click away on its own Unhide button.
    const slot = this.el.querySelector('[data-unhide-all-slot]');
    if (slot) {
      slot.innerHTML =
        hidden.length >= 2
          ? `<a href="#" data-unhide-all>${_('Unhide all')}</a>`
          : '';
    }
    this.grid.innerHTML = '';
    if (hidden.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hidden-features__empty';
      empty.textContent = _('Nothing hidden yet');
      this.grid.appendChild(empty);
      return;
    }
    // Registry order — the same order the circles use by default.
    for (const def of FOCUS_DOMAINS) {
      if (!hidden.includes(def.id)) continue;
      const chip = document.createElement('div');
      chip.className = 'focus-object-compact';
      chip.dataset.domainId = def.id;
      chip.innerHTML = `
        <span class="focus-object-compact__label">${def.label}</span>
        <button type="button" class="focus-object-compact__unhide" aria-label="${_('Unhide')}">
          <svg width="15" height="15" aria-hidden="true"><use href="#icon-eye-open"/></svg>
        </button>
      `;
      // The chip itself stays inert; only the Unhide button restores.
      chip
        .querySelector('.focus-object-compact__unhide')
        ?.addEventListener('click', e => {
          e.stopPropagation();
          unhideObject(def.id);
        });
      this.grid.appendChild(chip);
    }
  }

  destroy(): void {
    if (this.subId) {
      TypedEventBus.getInstance().off(this.subId);
      this.subId = null;
    }
    this.el?.removeEventListener('click', this.onClick);
    this.el = null;
    this.grid = null;
  }
}
