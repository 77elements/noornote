/**
 * Shared list header and breadcrumb rendering for bookmarks and tribes.
 * Extracts the identical markup structure; list-specific dropdown items
 * and breadcrumb root labels are passed as parameters.
 */

import { escapeHtml } from '../helpers/escapeHtml';
import { ICON_PLUS, ICON_CHEVRON_DOWN } from '../helpers/svgIcons';

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
    <button class="bookmark-header__dropdown-item" data-action="${item.action}">
      ${item.icon}
      ${escapeHtml(item.label)}
    </button>
  `).join('');

  return `
    <div class="bookmark-header">
      <h2 class="bookmark-header__title">${escapeHtml(title)}</h2>
      <div class="bookmark-header__new-dropdown">
          <button class="bookmark-header__new-btn" title="Create new">
            ${ICON_PLUS}
            New
            ${ICON_CHEVRON_DOWN}
          </button>
          <div class="bookmark-header__dropdown-menu">
            ${itemsHtml}
          </div>
        </div>
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
  const newBtn = container.querySelector('.bookmark-header__new-btn');
  const dropdown = container.querySelector('.bookmark-header__new-dropdown');

  newBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown?.classList.toggle('bookmark-header__new-dropdown--open');
  });

  if (closeHandler.current) {
    document.removeEventListener('click', closeHandler.current);
  }

  closeHandler.current = (e: Event) => {
    if (!dropdown?.contains(e.target as Node)) {
      dropdown?.classList.remove('bookmark-header__new-dropdown--open');
    }
  };
  document.addEventListener('click', closeHandler.current);
}
