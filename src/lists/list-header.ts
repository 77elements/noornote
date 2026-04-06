/**
 * Shared list header and breadcrumb rendering for bookmarks and tribes.
 * Extracts the identical markup structure; list-specific dropdown items
 * and breadcrumb root labels are passed as parameters.
 */

import { escapeHtml } from '../helpers/escapeHtml';

export interface DropdownItem {
  action: string;   // data-action value, e.g. 'new-folder'
  icon: string;     // SVG string
  label: string;    // display text, e.g. 'Folder'
}

/**
 * Render the list header with title and "New" dropdown button.
 */
export function renderListHeader(title: string, dropdownItems: DropdownItem[]): string {
  const itemsHtml = dropdownItems.map(item => `
    <li class="custom-dropdown__item" data-action="${item.action}">
      ${item.icon}
      ${escapeHtml(item.label)}
    </li>
  `).join('');

  return `
    <div class="l-spread">
      <h2>${escapeHtml(title)}</h2>
      <div class="custom-dropdown" data-list-header-dropdown>
        <button class="custom-dropdown__trigger" type="button" title="Create new">
          <span class="custom-dropdown__label">+ New</span>
          <span class="custom-dropdown__arrow" aria-hidden="true"></span>
        </button>
        <ul class="custom-dropdown__menu" role="listbox">
          ${itemsHtml}
        </ul>
      </div>
    </div>
  `;
}

/**
 * Render breadcrumb navigation for folder views.
 */
export function renderListBreadcrumb(rootLabel: string, folderName: string): string {
  return `
    <div class="bookmark-breadcrumb">
      <span class="bookmark-breadcrumb__item" data-navigate="root">${escapeHtml(rootLabel)}</span>
      <span class="bookmark-breadcrumb__separator">/</span>
      <span class="bookmark-breadcrumb__item bookmark-breadcrumb__item--current">${escapeHtml(folderName)}</span>
    </div>
  `;
}

/**
 * Bind the header dropdown toggle and outside-click close handler.
 * Returns a cleanup function to remove the document listener.
 */
export function bindHeaderDropdown(
  container: HTMLElement,
  closeHandler: { current: ((e: Event) => void) | null }
): void {
  const dropdown = container.querySelector('[data-list-header-dropdown]');
  const trigger = dropdown?.querySelector('.custom-dropdown__trigger');

  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown?.classList.toggle('custom-dropdown--open');
  });

  if (closeHandler.current) {
    document.removeEventListener('click', closeHandler.current);
  }

  closeHandler.current = (e: Event) => {
    if (!dropdown?.contains(e.target as Node)) {
      dropdown?.classList.remove('custom-dropdown--open');
    }
  };
  document.addEventListener('click', closeHandler.current);
}
