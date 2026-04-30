/**
 * BlockLibraryView — catalog of available block types with [Apply] buttons.
 *
 * Mounted in the SCC "Block Library" tab on Desktop, in the Mobile-Overlay
 * lower-half on Phone. Identical content for both. No hover-only controls;
 * Apply buttons are always visible.
 *
 * Footer (Slice 5a):
 *   - "Saved locally ✓" indicator (visible when a v2 draft exists)
 *   - "Discard draft" button (active when a draft exists)
 *   - "Publish to relays" button (placeholder until Slice 5b)
 *
 * Active block types: heading, text, list, divider, links
 * Disabled (Apply replaced by "Soon"): image, gallery, embed,
 *   bookmark-folder, columns — renderers/editors arrive in later slices.
 */

import type { BlockType } from './types';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { EventBus } from '../../../services/EventBus';

interface BlockLibraryViewOptions {
  onApply: (type: BlockType) => void;
  onDiscard: () => void;
  onPublish: () => Promise<void>;
  getHasDraft: () => boolean;
}

interface BlockTypeMeta {
  type: BlockType;
  label: string;
  description: string;
  icon: string;
  enabled: boolean;
}

const CATALOG: BlockTypeMeta[] = [
  { type: 'heading',         label: 'Heading',         description: 'Section title (h1/h2/h3)',                icon: '◆', enabled: true },
  { type: 'text',            label: 'Text',            description: 'Plain paragraph with line breaks',         icon: '¶', enabled: true },
  { type: 'list',            label: 'Custom List',     description: 'Title + bullet items',                     icon: '☰', enabled: true },
  { type: 'links',           label: 'Links',           description: 'List of clickable links with labels',      icon: '🔗', enabled: true },
  { type: 'divider',         label: 'Divider',         description: 'Horizontal separator line',                icon: '─', enabled: true },
  { type: 'image',           label: 'Image',           description: 'Single image with optional caption',       icon: '🖼', enabled: true },
  { type: 'gallery',         label: 'Gallery',         description: 'Multi-image grid',                         icon: '⚏', enabled: true },
  { type: 'embed',           label: 'Nostr Embed',     description: 'Embed a Nostr note or article',            icon: '🔮', enabled: true },
  { type: 'bookmark-folder', label: 'Bookmark Folder', description: 'Mount an existing bookmark folder',        icon: '📁', enabled: true },
  { type: 'columns',         label: 'Columns',         description: '2- or 3-column layout',                    icon: '⊞', enabled: false },
];

export class BlockLibraryView {
  private container: HTMLElement;
  private opts: BlockLibraryViewOptions;
  private draftSubscriptionId: string | null = null;

  constructor(opts: BlockLibraryViewOptions) {
    this.opts = opts;
    this.container = document.createElement('div');
    this.container.className = 'block-library';
    this.render();
    this.bindEvents();
    this.subscribeToDraftChanges();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.draftSubscriptionId) {
      EventBus.getInstance().off(this.draftSubscriptionId);
      this.draftSubscriptionId = null;
    }
    this.container.innerHTML = '';
  }

  private subscribeToDraftChanges(): void {
    this.draftSubscriptionId = EventBus.getInstance().on('mypageDraftV2:changed', () => {
      // Refresh footer state without rebuilding the catalog rows
      this.updateFooter();
    });
  }

  private render(): void {
    const rowsHtml = CATALOG.map(meta => `
      <div class="block-library__row${meta.enabled ? '' : ' block-library__row--disabled'}" data-block-type="${meta.type}">
        <div class="block-library__icon" aria-hidden="true">${escapeHtml(meta.icon)}</div>
        <div class="block-library__info">
          <div class="block-library__label">${escapeHtml(meta.label)}</div>
          <div class="block-library__description">${escapeHtml(meta.description)}</div>
        </div>
        <button
          type="button"
          class="btn btn--passive btn--mini block-library__apply"
          data-action="apply"
          data-block-type="${meta.type}"
          ${meta.enabled ? '' : 'disabled'}
        >${meta.enabled ? 'Apply' : 'Soon'}</button>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="block-library__intro">
        <p>Click <strong>Apply</strong> to add a block to the end of your page.</p>
      </div>
      <div class="block-library__rows">${rowsHtml}</div>
      <div class="block-library__footer" data-footer></div>
    `;

    this.updateFooter();
  }

  private updateFooter(): void {
    const footer = this.container.querySelector('[data-footer]') as HTMLElement | null;
    if (!footer) return;
    const hasDraft = this.opts.getHasDraft();

    footer.innerHTML = `
      <div class="block-library__footer-status">
        ${hasDraft ? '<span class="block-library__saved-indicator">Saved locally ✓</span>' : '<span class="block-library__no-draft">No unpublished changes</span>'}
      </div>
      <div class="block-library__footer-actions">
        <button type="button" class="btn btn--passive btn--mini" data-action="discard" ${hasDraft ? '' : 'disabled'}>Discard draft</button>
        <button type="button" class="btn btn--mini" data-action="publish" ${hasDraft ? '' : 'disabled'}>Publish to relays</button>
      </div>
    `;
  }

  private bindEvents(): void {
    // Single delegated listener — survives footer re-renders via updateFooter()
    this.container.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      const action = btn.dataset.action!;

      if (action === 'apply') {
        const type = btn.dataset.blockType as BlockType;
        if (type) this.opts.onApply(type);
      } else if (action === 'discard') {
        this.opts.onDiscard();
      } else if (action === 'publish') {
        // Disable the button during publish to prevent double-clicks
        const button = btn as HTMLButtonElement;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Publishing...';
        try {
          await this.opts.onPublish();
        } finally {
          // BlockLibraryView may already be destroyed by onPublish (closeBlockLibrary)
          if (button.isConnected) {
            button.disabled = !this.opts.getHasDraft();
            button.textContent = originalText;
          }
        }
      }
    });
  }
}
