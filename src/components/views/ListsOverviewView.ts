/**
 * ListsOverviewView — the `/lists` route (no slug).
 *
 * Tile overview of the four lists (Bookmarks, Follows, Muted, Tribes),
 * mirroring the /addons overview pattern (2026-09-24). The nav wheel's
 * "Lists" item navigates here; the classic sidebar keeps its accordion
 * submenu.
 *
 * - Tiles: .nn-card with name, description and list icon.
 * - Click opens the list tab via the shared `list:open` event (same path
 *   as Settings → Privacy links, ProfileView, FollowPackDetailView).
 * - Bookmarks/Tribes tiles respect their addon flags: disabled shows the
 *   tile greyed out with an "inactive" hint instead of hiding it.
 */

import { View } from './View';
import { escapeHtml } from '../../helpers/escapeHtml';
import { TypedEventBus } from '../../core/TypedEventBus';
import { isBookmarksEnabled } from '../../addons/bookmarks/index';
import { isTribesEnabled } from '../../addons/tribes/index';
import type { ListType } from '../layout/partials/ListViewPartial';

// JS selection via data attributes only (scss rule: CSS classes are for
// styling, never for querySelector).
const TILE_SELECTOR = '[data-list-tile]';

interface ListTile {
  id: ListType;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  disableHint: string;
}

export class ListsOverviewView extends View {
  private container: HTMLElement;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--lists-overview';
    this.renderContent();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }

  private getTiles(): ListTile[] {
    const bookmarksEnabled = isBookmarksEnabled();
    const tribesEnabled = isTribesEnabled();
    return [
      {
        id: 'bookmarks',
        name: 'Bookmarks',
        description: 'Saved notes, sorted into folders.',
        icon: 'icon-bookmark-24',
        enabled: bookmarksEnabled,
        disableHint: 'Enable the Bookmarks addon in Settings → Addons.',
      },
      {
        id: 'follows',
        name: 'Follows',
        description: 'The accounts you follow, with outbox relays.',
        icon: 'icon-follows',
        enabled: true,
        disableHint: '',
      },
      {
        id: 'mutes',
        name: 'Muted',
        description: 'Accounts and threads you have muted.',
        icon: 'icon-mute-mic',
        enabled: true,
        disableHint: '',
      },
      {
        id: 'tribes',
        name: 'Tribes',
        description: 'Curated public follow lists you subscribe to.',
        icon: 'icon-tribes-circles',
        enabled: tribesEnabled,
        disableHint: 'Enable the Tribes addon in Settings → Addons.',
      },
    ];
  }

  private renderContent(): void {
    this.container.innerHTML = `
      <div class="lists-overview__head l-spread">
        <h2>Lists</h2>
      </div>
      <p class="lists-overview__intro">
        Your lists are stored locally and synced to your relays. Pick one to
        open it.
      </p>
      <div class="nn-card-grid-wrap">
        <div class="nn-card-grid lists-overview__grid" data-lists-grid>
          ${this.getTiles()
            .map(t => this.renderTile(t))
            .join('')}
        </div>
      </div>
    `;

    this.wireGrid();
  }

  private renderTile(t: ListTile): string {
    const disabled = !t.enabled;
    // Bookmarks tile: unread diode (same .notifications-badge chrome as the
    // nav badges), top-right of the card left of the tile icon — driven by
    // ListsCountManager via data-list-unread.
    const meta =
      t.id === 'bookmarks'
        ? `<span class="list-tile__meta">
            <span class="notifications-badge" data-list-unread="bookmarks"></span>
            <svg class="list-tile__icon"><use href="#${t.icon}"/></svg>
          </span>`
        : `<svg class="list-tile__icon"><use href="#${t.icon}"/></svg>`;
    return `
      <div class="nn-card list-tile" data-list-tile="${escapeHtml(t.id)}"${
        disabled ? ' data-list-tile-disabled' : ''
      }>
        <div class="nn-card__content">
          <div class="list-tile__head l-spread">
            <h3>${escapeHtml(t.name)}</h3>
            ${meta}
          </div>
          <p class="list-tile__desc">${escapeHtml(
            disabled && t.disableHint ? t.disableHint : t.description
          )}</p>
        </div>
      </div>
    `;
  }

  private wireGrid(): void {
    const grid = this.container.querySelector(
      '[data-lists-grid]'
    ) as HTMLElement;
    if (!grid) return;

    grid.addEventListener('click', e => {
      const tile = (e.target as HTMLElement).closest(
        TILE_SELECTOR
      ) as HTMLElement | null;
      if (!tile || tile.hasAttribute('data-list-tile-disabled')) return;
      const listType = tile.dataset.listTile as ListType;
      if (listType) {
        TypedEventBus.getInstance().emit('list:open', { listType });
      }
    });
  }
}
