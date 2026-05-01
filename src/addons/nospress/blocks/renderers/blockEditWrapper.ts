/**
 * Wraps an editable block's content with the always-visible Move/Delete
 * toolbar. Used by all block renderers when editable=true. Mobile-first,
 * no hover — toolbar is permanently rendered.
 */
export function wrapEditable(blockId: string, type: string, contentHtml: string): string {
  return `
    <div class="nospress-block-edit" data-block-id="${blockId}" data-block-type="${type}">
      <div class="nospress-block-edit__toolbar">
        <span class="nospress-block-edit__type-badge">${type}</span>
        <div class="nospress-block-edit__actions">
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
