/**
 * BlockLibraryView — catalog of available block types with [Apply] buttons.
 *
 * Mounted in the SCC "Block Library" tab on Desktop, in the Mobile-Overlay
 * lower-half on Phone. Identical content for both. No hover-only controls;
 * Apply buttons are always visible.
 *
 * After the native catalog, the user's saved Custom Blocks (per-account
 * templates lifted from multi-selections via "Save as custom block") are
 * appended — each card carries an Apply + delete action.
 *
 * Save / Discard / Publish controls live in the PCC action bar (NospressView)
 * so they remain reachable on Mobile, where the SCC isn't visible.
 */

import type { BlockType } from './types';
import { BLOCK_CATALOG } from './blockCatalog';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { getCustomBlocks } from '../customBlocks';

interface BlockLibraryViewOptions {
  onApply: (type: BlockType) => void;
  /** Click on the virtual "Custom CSS" entry — toggles the Custom-CSS panel
   *  between the page header and the page-edit area. No Apply button. */
  onSelectCss: () => void;
  /** Apply a saved Custom Block template at the cursor. NospressView
   *  iterates the template's stripped blocks and inserts each with
   *  fresh UUIDs. */
  onApplyCustom: (id: string) => void;
  /** Delete a saved Custom Block from the user's library. */
  onDeleteCustom: (id: string) => void;
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

  /** Re-render in place — used after the user saves / deletes a Custom
   *  Block so the library shows the new state without a full editor
   *  reload. Event delegation survives because it's bound to `container`,
   *  not to per-card descendants. */
  public refresh(): void {
    this.render();
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

    const customBlocks = getCustomBlocks();
    const customRowsHtml = customBlocks.map(cb => `
      <div class="nn-card nn-card--custom-block" data-custom-block-id="${escapeHtmlAttr(cb.id)}">
        <div class="nn-card__content">
          <div class="icon" aria-hidden="true">🧩</div>
          <h3>${escapeHtml(cb.name)}</h3>
          <div class="block-library__custom-actions">
            <button type="button" class="btn btn--passive btn--mini"
                    data-action="apply-custom" data-custom-id="${escapeHtmlAttr(cb.id)}">Apply</button>
            <button type="button" class="btn btn--passive btn--mini block-library__custom-delete"
                    data-action="delete-custom" data-custom-id="${escapeHtmlAttr(cb.id)}"
                    title="Delete custom block" aria-label="Delete">×</button>
          </div>
        </div>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="block-library__rows">${cssRowHtml}${rowsHtml}${customRowsHtml}</div>
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

      const applyCustom = target.closest('[data-action="apply-custom"]') as HTMLElement | null;
      if (applyCustom) {
        const id = applyCustom.dataset.customId;
        if (id) this.opts.onApplyCustom(id);
        return;
      }

      const deleteCustom = target.closest('[data-action="delete-custom"]') as HTMLElement | null;
      if (deleteCustom) {
        const id = deleteCustom.dataset.customId;
        if (id) this.opts.onDeleteCustom(id);
        return;
      }

      const btn = target.closest('[data-action="apply"]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      const type = btn.dataset.blockType as BlockType;
      if (type) this.opts.onApply(type);
    });
  }
}
