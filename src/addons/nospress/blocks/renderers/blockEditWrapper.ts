/**
 * Wraps an editable block's content with the always-visible Move/Delete
 * toolbar. Used by all block renderers when editable=true. Mobile-first,
 * no hover — toolbar is permanently rendered.
 *
 * `extraButtons` lets specific block types prepend their own toolbar
 * actions (e.g. heading/text inject an Insert-Link button before the
 * generic move/delete cluster).
 *
 * `badgeOverride` replaces the static `<span class="…__type-badge">div</span>`
 * label on the left of the toolbar with caller-supplied HTML. Used by the
 * `div` block to surface its HTML-tag picker (header / footer / main / …)
 * directly in the toolbar — the static "div" label was redundant since the
 * div block is the only one whose semantic tag is user-chooseable.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../../../services/PerAccountLocalStorage';

/** True when the per-account styles clipboard has a payload — used to
 *  conditionally render the Paste-Styles button on every editable block.
 *  Read fresh on each block render: NospressView re-runs the entire
 *  editable tree after every copy/paste action, so the flag is always
 *  in sync with the latest clipboard state. */
function hasStylesInClipboard(): boolean {
  const data = PerAccountLocalStorage.getInstance().get<unknown>(
    StorageKeys.NOSPRESS_STYLES_CLIPBOARD, null,
  );
  return data != null;
}

export function wrapEditable(
  blockId: string,
  type: string,
  contentHtml: string,
  extraButtons: string = '',
  badgeOverride: string = '',
): string {
  const showPasteStyles = hasStylesInClipboard();
  const badgeHtml = badgeOverride || `<span class="nospress-block-edit__type-badge">${type}</span>`;
  return `
    <div class="nospress-block-edit" data-block-edit data-block-id="${blockId}" data-block-type="${type}">
      <div class="nospress-block-edit__toolbar">
        ${badgeHtml}
        <div class="nospress-block-edit__actions">
          ${extraButtons}
          <button type="button" class="nospress-block-edit__btn" data-block-id="${blockId}" data-action="copy-block" title="Copy block (with properties)" aria-label="Copy block">
            <svg width="14" height="14"><use href="#icon-copy"/></svg>
          </button>
          <button type="button" class="nospress-block-edit__btn" data-block-id="${blockId}" data-action="copy-block-styles" title="Copy styles only" aria-label="Copy styles">
            <svg width="14" height="14"><use href="#icon-highlight"/></svg>
          </button>
          ${showPasteStyles ? `<button type="button" class="nospress-block-edit__btn" data-block-id="${blockId}" data-action="paste-block-styles" title="Paste styles onto this block" aria-label="Paste styles">
            <svg width="14" height="14"><use href="#icon-paint-bucket"/></svg>
          </button>` : ''}
          <button type="button" class="nospress-block-edit__btn" data-block-id="${blockId}" data-action="cursor-after" title="Move cursor below this block" aria-label="Move cursor below">
            <svg width="14" height="14"><use href="#icon-plus"/></svg>
          </button>
          <button type="button" class="nospress-block-edit__btn" data-block-id="${blockId}" data-action="move-up" title="Move up" aria-label="Move up">
            <svg width="14" height="14"><use href="#icon-chevron-up"/></svg>
          </button>
          <button type="button" class="nospress-block-edit__btn" data-block-id="${blockId}" data-action="move-down" title="Move down" aria-label="Move down">
            <svg width="14" height="14"><use href="#icon-chevron-down"/></svg>
          </button>
          <button type="button" class="nospress-block-edit__btn nospress-block-edit__btn--danger" data-block-id="${blockId}" data-action="delete" title="Delete block" aria-label="Delete">
            <svg width="14" height="14"><use href="#icon-close"/></svg>
          </button>
        </div>
      </div>
      <div class="nospress-block-edit__content">${contentHtml}</div>
    </div>
  `;
}
