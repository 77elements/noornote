/**
 * AddonsOverviewView — the `/addons` route (no slug).
 *
 * Tile overview of all registered addons (src/addons/registry.ts), replacing
 * the former 22-entry sidebar submenu (2026-09-19,
 * docs/todos/addons-overview-page.md).
 *
 * - Tiles: .nn-card with name, description and an enabled/inactive LED.
 *   Click opens the addon's own route.
 * - Order: per-account via addonOrder.ts (default alphabetical).
 * - Reorder: desktop drag via the shared setupGridDragDrop (bookmarks
 *   mechanics), touch ▲▼ buttons (platform--mobile only).
 * - Reset: back to the alphabetical default, only visible when a custom
 *   order exists.
 */

import { View } from './View';
import { Router } from '../../services/Router';
import { ToastService } from '../../services/ToastService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { setupGridDragDrop } from '../../helpers/gridDragDrop';
import {
  getOrderedAddons,
  saveAddonOrder,
  hasCustomAddonOrder,
  resetAddonOrder,
  reorderAddonIds,
} from '../../addons/addonOrder';
import { getAddonEnabled } from '../../addons/addonFlags';
import { ADDON_REGISTRY, type AddonRegistryEntry } from '../../addons/registry';

const TILE_SELECTOR = '.addon-tile';

export class AddonsOverviewView extends View {
  private container: HTMLElement;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addons-overview';
    this.renderContent();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    // gridDragDrop wires its mousedown listener on the grid node — it dies
    // with the DOM. Nothing long-lived to unwind.
    this.container.innerHTML = '';
  }

  private renderContent(): void {
    const addons = getOrderedAddons();

    this.container.innerHTML = `
      <div class="addons-overview__head l-spread">
        <h2>Addons</h2>
        <div>
          <button class="btn btn--passive btn--mini" data-addons-reset ${hasCustomAddonOrder() ? '' : 'hidden'}>
            Reset order
          </button>
        </div>
      </div>
      <p class="addons-overview__intro">
        Addons are extra functions that build on and enhance your NoorNote
        experience. Right now, there are ${ADDON_REGISTRY.length} of them.
      </p>
      <p class="addons-overview__hint">
        Drag tiles to reorder (on touch: use ▲▼). The order is saved per account.
      </p>
      <div class="nn-card-grid-wrap">
        <div class="nn-card-grid addons-overview__grid">
          ${addons.map(a => this.renderTile(a)).join('')}
        </div>
      </div>
    `;

    this.wireGrid();
    this.wireReset();
  }

  private renderTile(a: AddonRegistryEntry): string {
    const enabled = getAddonEnabled(a.id);
    const status =
      a.status === 'new' || a.status === 'updated' ? a.status : null;
    return `
      <div class="nn-card addon-tile" data-addon-id="${escapeHtml(a.id)}">
        <div class="nn-card__content">
          <div class="addon-tile__head l-spread">
            <h3>${escapeHtml(a.name)}</h3>
            <div class="addon-tile__meta">
              ${
                status
                  ? `<span class="addon-tile__status addon-tile__status--${status}">${status === 'new' ? 'New' : 'Updated'}</span>`
                  : ''
              }
              <span
                class="addon-tile__led ${enabled ? 'addon-tile__led--on' : 'addon-tile__led--off'}"
                title="${enabled ? 'Active' : 'Inactive'}"
              ></span>
            </div>
          </div>
          <p class="addon-tile__desc">${escapeHtml(a.description)}</p>
          <div class="l-row l-row--right addon-tile__move">
            <button class="addon-tile__move-btn" data-move="up" aria-label="Move up">
              <svg><use href="#icon-caret-up"/></svg>
            </button>
            <button class="addon-tile__move-btn" data-move="down" aria-label="Move down">
              <svg><use href="#icon-caret-down"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private wireGrid(): void {
    const grid = this.container.querySelector(
      '.addons-overview__grid'
    ) as HTMLElement;
    if (!grid) return;

    // Tile click → open the addon page. Suppress after a drag (same pattern
    // as bookmarks/tribes) and never navigate from the ▲▼ buttons.
    grid.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.closest('button')) return;
      const tile = target.closest(TILE_SELECTOR) as HTMLElement | null;
      if (!tile) return;
      if (tile.dataset.wasDragging) {
        delete tile.dataset.wasDragging;
        return;
      }
      const entry = ADDON_REGISTRY.find(a => a.id === tile.dataset.addonId);
      if (entry) Router.getInstance().navigate(entry.route);
    });

    // Touch reorder: ▲ moves before the previous tile, ▼ after the next one.
    grid.addEventListener('click', e => {
      const btn = e.target as HTMLElement;
      const moveBtn = btn.closest(
        '.addon-tile__move-btn'
      ) as HTMLElement | null;
      if (!moveBtn) return;
      const tile = moveBtn.closest(TILE_SELECTOR) as HTMLElement | null;
      if (!tile) return;
      const up = moveBtn.dataset.move === 'up';
      const neighbor = up
        ? (tile.previousElementSibling as HTMLElement | null)
        : (tile.nextElementSibling as HTMLElement | null);
      if (!neighbor || !neighbor.matches(TILE_SELECTOR)) return;
      this.reorder(
        grid,
        tile.dataset.addonId || '',
        neighbor.dataset.addonId || '',
        up ? 'before' : 'after'
      );
    });

    setupGridDragDrop(grid, {
      itemSelector: TILE_SELECTOR,
      excludeSelector: 'button',
      placeholderClass: 'addon-tile-placeholder',
      getItemId: el => el.dataset.addonId || null,
      onDrop: (draggedId, _draggedEl, dropTarget) => {
        const targetId = (dropTarget as HTMLElement).dataset.addonId;
        if (!targetId || targetId === draggedId) return;
        // reorder() performs the DOM move (insertBefore semantics) + persist.
        this.reorder(grid, draggedId, targetId, 'before');
      },
    });
  }

  /**
   * Move `draggedId` before/after `targetId` — the pure reorderAddonIds()
   * decides the new order, the DOM node move mirrors it, then persist.
   */
  private reorder(
    grid: HTMLElement,
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): void {
    const current = this.currentIds(grid);
    const next = reorderAddonIds(current, draggedId, targetId, position);
    if (next === current) return;

    const draggedEl = grid.querySelector(
      `${TILE_SELECTOR}[data-addon-id="${draggedId}"]`
    );
    const targetEl = grid.querySelector(
      `${TILE_SELECTOR}[data-addon-id="${targetId}"]`
    );
    if (!draggedEl || !targetEl) return;

    if (position === 'before') {
      grid.insertBefore(draggedEl, targetEl);
    } else {
      grid.insertBefore(draggedEl, targetEl.nextElementSibling);
    }
    saveAddonOrder(next);
    this.updateResetVisibility();
  }

  private currentIds(grid: HTMLElement): string[] {
    return Array.from(grid.querySelectorAll(TILE_SELECTOR))
      .map(el => (el as HTMLElement).dataset.addonId || '')
      .filter(Boolean);
  }

  private wireReset(): void {
    const resetBtn = this.container.querySelector('[data-addons-reset]');
    resetBtn?.addEventListener('click', () => {
      resetAddonOrder();
      ToastService.show('Addon order reset to default', 'success');
      this.renderContent();
    });
  }

  private updateResetVisibility(): void {
    const resetBtn = this.container.querySelector(
      '[data-addons-reset]'
    ) as HTMLElement | null;
    if (resetBtn) resetBtn.hidden = !hasCustomAddonOrder();
  }
}
