/**
 * Shared user-search result rows.
 *
 * One renderer for the Spotlight's user suggestions and the v2 Search
 * object — identical markup and `.search-spotlight__user-*` classes
 * (styles in _search-spotlight.scss), so both surfaces stay in sync.
 */

import type { UserSearchResult } from '../../services/UserSearchService';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { _ } from '../../i18n';

export const renderUserSearchRows = (users: UserSearchResult[]): string =>
  users
    .slice(0, 8)
    .map((user, index) => {
      const displayName = user.displayName || user.name || _('Anonymous');
      const picture = user.picture || '';
      const followBadge = user.isFollowing
        ? `<span class="badge badge--accent">${_('Following')}</span>`
        : '';

      return `
        <div class="search-spotlight__user-item" data-pubkey="${user.pubkey}" data-user-index="${index}">
          <div class="search-spotlight__user-avatar">
            ${picture ? `<img src="${escapeHtmlAttr(picture)}" alt="" loading="lazy" />` : '<div class="search-spotlight__user-avatar-placeholder"></div>'}
          </div>
          <div class="search-spotlight__user-info">
            <span class="search-spotlight__user-name">${escapeHtml(displayName)}</span>
            ${user.nip05 ? `<span class="search-spotlight__user-nip05">${escapeHtml(user.nip05)}</span>` : ''}
          </div>
          ${followBadge}
        </div>
      `;
    })
    .join('');
