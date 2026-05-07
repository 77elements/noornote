/**
 * BlockLibraryView — catalog of available block types with [Apply] buttons.
 *
 * Mounted in the SCC "Block Library" tab on Desktop, in the Mobile-Overlay
 * lower-half on Phone. Identical content for both. No hover-only controls;
 * Apply buttons are always visible.
 *
 * Save / Discard / Publish controls live in the PCC action bar (NospressView)
 * so they remain reachable on Mobile, where the SCC isn't visible.
 */

import type { BlockType } from './types';
import { BLOCK_CATALOG } from './blockCatalog';
import { escapeHtml } from '../../../helpers/escapeHtml';

interface BlockLibraryViewOptions {
  onApply: (type: BlockType) => void;
  /** Click on the virtual "Custom CSS" entry — toggles the Custom-CSS panel
   *  between the page header and the page-edit area. No Apply button. */
  onSelectCss: () => void;
}

export class BlockLibraryView {
  private container: HTMLElement;
  private opts: BlockLibraryViewOptions;

  constructor(opts: BlockLibraryViewOptions) {
    this.opts = opts;
    this.container = document.createElement('div');
    this.container.className = 'block-library';
    this.render();
    this.bindEvents();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }

  private render(): void {
    // Virtual "Custom CSS" entry — opens the textarea panel between header
    // and page-edit. Same panel as the header "CSS Editor" button, so the
    // user has two equivalent entry points.
    const cssRowHtml = `
      <div class="nn-card" data-action="select-css" role="button" tabindex="0">
        <div class="nn-card__content">
          <div class="icon" aria-hidden="true">{ }</div>
          <h3>Custom CSS</h3>
        </div>
      </div>
    `;

    const rowsHtml = BLOCK_CATALOG.map(meta => `
      <div class="nn-card"${meta.enabled ? '' : ' data-disabled'} data-block-type="${meta.type}">
        <div class="nn-card__content">
          <div class="icon" aria-hidden="true">${escapeHtml(meta.icon)}</div>
          <h3>${escapeHtml(meta.label)}</h3>
          <div>
            <button
              type="button"
              class="btn btn--passive btn--mini"
              data-action="apply"
              data-block-type="${meta.type}"
              ${meta.enabled ? '' : 'disabled'}
            >${meta.enabled ? 'Apply' : 'Soon'}</button>
          </div>
        </div>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="block-library__rows">${cssRowHtml}${rowsHtml}</div>
    `;
  }

  private bindEvents(): void {
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const cssRow = target.closest('[data-action="select-css"]');
      if (cssRow) {
        this.opts.onSelectCss();
        return;
      }

      const btn = target.closest('[data-action="apply"]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      const type = btn.dataset.blockType as BlockType;
      if (type) this.opts.onApply(type);
    });
  }
}
