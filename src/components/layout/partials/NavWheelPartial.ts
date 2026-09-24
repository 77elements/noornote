/**
 * NavWheelPartial
 * Circular navigation wheel for the sidebar (default nav mode).
 *
 * @purpose Renders the 8 primary nav items on a static circle (variant A,
 * 2026-09-24 prototype) with the NoorNote logo at its center. Replaces the
 * linear `.primary-nav` list as the DEFAULT navigation; the old list stays
 * in the DOM for the "Classic Menu" setting (html.classic-nav), the logged-out
 * state and the collapsed icon rail.
 *
 * - Purely static: no wheel rotation. The active item is highlighted with the
 *   app-wide accent language (`--bg-accent` + `--color-4`, same as the
 *   classic nav's hover/active styles).
 * - Clicking the already-active item scrolls the view to the top (same
 *   behavior as the classic Timeline/Profile/Articles items).
 * - Badges reuse the original `.notifications-badge` / `.dm-badge` classes so
 *   the existing badge managers drive them unchanged.
 */

import { viewClassToWheelItem } from '../../../helpers/navModeSetting';

export type WheelItemId =
  | 'timeline'
  | 'profile'
  | 'notifications'
  | 'articles'
  | 'messages'
  | 'lists'
  | 'settings'
  | 'addons';

export interface NavWheelCallbacks {
  /** Classic home/timeline logic incl. list-in-pcc replace (MainLayout.handleHomeClick). */
  timeline: () => void;
  /** Own-profile navigation (view controller, middle-click aware). */
  profile: (e: MouseEvent) => void;
  notifications: (e: MouseEvent) => void;
  /** Articles incl. scroll-to-top-when-active (MainLayout logic). */
  articles: (e: MouseEvent) => void;
  messages: (e: MouseEvent) => void;
  /** Open the /lists overview page. */
  lists: () => void;
  settings: () => void;
  addons: () => void;
}

interface WheelItemDef {
  id: WheelItemId;
  label: string;
  icon: string;
  angle: number; // placement angle in deg; -90 = 12 o'clock, clockwise
  badge?: 'notifications' | 'dm' | 'bookmarks-unread';
  route: string;
}

const ITEMS: WheelItemDef[] = [
  {
    id: 'timeline',
    label: 'Timeline',
    icon: 'icon-home',
    angle: -90,
    route: '/',
  },
  {
    id: 'profile',
    label: 'Profile',
    icon: 'icon-profile',
    angle: -45,
    route: '/profile',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: 'icon-notifications',
    angle: 0,
    badge: 'notifications',
    route: '/notifications',
  },
  {
    id: 'articles',
    label: 'Articles',
    icon: 'icon-articles',
    angle: 45,
    route: '/articles',
  },
  {
    id: 'messages',
    label: 'Messages',
    icon: 'icon-email',
    angle: 90,
    badge: 'dm',
    route: '/messages',
  },
  {
    id: 'lists',
    label: 'Lists',
    icon: 'icon-folder',
    angle: 135,
    badge: 'bookmarks-unread',
    route: '/lists',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'icon-settings',
    angle: 180,
    route: '/settings',
  },
  {
    id: 'addons',
    label: 'Addons',
    icon: 'icon-addons',
    angle: 225,
    route: '/addons',
  },
];

const ITEM_SELECTOR = '[data-wheel-item]';

export class NavWheelPartial {
  private callbacks: NavWheelCallbacks;
  private element: HTMLElement | null = null;

  constructor(callbacks: NavWheelCallbacks) {
    this.callbacks = callbacks;
  }

  public createElement(): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'nn-wheel';
    nav.setAttribute('aria-label', 'Main navigation');

    nav.innerHTML = `
      <span class="nn-wheel__center" aria-hidden="true">
        <svg class="nn-wheel__logo"><use href="#nn-logo"/></svg>
      </span>
      ${ITEMS.map(item => this.renderItem(item)).join('')}
    `;

    this.wireClicks(nav);
    this.element = nav;
    return nav;
  }

  private renderItem(item: WheelItemDef): string {
    let badge = '';
    if (item.badge === 'notifications') {
      badge = '<span class="notifications-badge nn-wheel__badge"></span>';
    } else if (item.badge === 'dm') {
      badge =
        '<span class="badge badge--green dm-badge nn-wheel__badge"></span>';
    } else if (item.badge === 'bookmarks-unread') {
      // Unread-bookmark diode (same chrome as the notifications badge);
      // driven by ListsCountManager via data-list-unread.
      badge =
        '<span class="notifications-badge nn-wheel__badge" data-list-unread="bookmarks"></span>';
    }
    return `
      <button
        type="button"
        class="nn-wheel__item"
        data-wheel-item="${item.id}"
        data-wheel-route="${item.route}"
        style="--a: ${item.angle}deg"
        title="${item.label}"
        aria-label="${item.label}"
      >
        <svg class="nn-wheel__icon"><use href="#${item.icon}"/></svg>
        <span class="nn-wheel__label">${item.label}</span>
        ${badge}
      </button>
    `;
  }

  private wireClicks(nav: HTMLElement): void {
    const closeDrawer = () => {
      const sidebar = nav.closest('.sidebar');
      const overlay = nav
        .closest('.main-layout')
        ?.querySelector('.sidebar-overlay');
      sidebar?.classList.remove('sidebar--open');
      overlay?.classList.remove('sidebar-overlay--visible');
    };

    const handlers: Record<WheelItemId, (e: MouseEvent) => void> = {
      timeline: () => this.callbacks.timeline(),
      profile: e => this.callbacks.profile(e),
      notifications: e => this.callbacks.notifications(e),
      articles: e => this.callbacks.articles(e),
      messages: e => this.callbacks.messages(e),
      lists: () => this.callbacks.lists(),
      settings: () => this.callbacks.settings(),
      addons: () => this.callbacks.addons(),
    };

    nav.querySelectorAll<HTMLElement>(ITEM_SELECTOR).forEach(btn => {
      const id = btn.dataset.wheelItem as WheelItemId;
      const handler = handlers[id];
      if (!handler) return;

      // Middle-click / modifier-click behave like the classic links: the
      // MouseEvent is delegated unchanged so the view controller's click
      // analysis (right-pane tabs) sees button/modifier state.
      const run = (e: MouseEvent) => {
        e.preventDefault();
        handler(e);
        closeDrawer();
      };
      btn.addEventListener('click', run);
      btn.addEventListener('auxclick', run as EventListener);
    });
  }

  /**
   * Highlight the item matching the router's viewClass abbreviation
   * (tv/pv/nv/atv/av/aev/mv/cv/sv/adv/lov). Null clears the highlight.
   */
  public setActive(viewClass: string | null): void {
    if (!this.element) return;
    const activeId = viewClass ? viewClassToWheelItem(viewClass) : null;
    this.element.querySelectorAll<HTMLElement>(ITEM_SELECTOR).forEach(btn => {
      btn.classList.toggle(
        'nn-wheel__item--active',
        activeId !== null && btn.dataset.wheelItem === activeId
      );
    });
  }

  /**
   * Mark the Lists item active while a list tab (bookmarks/follows/mutes/
   * tribes) is open; null clears it. List views have no router viewClass of
   * their own — MainLayout calls this from setActiveListSublink.
   */
  public setListActive(listType: string | null): void {
    if (!this.element) return;
    const btn = this.element.querySelector<HTMLElement>(
      `${ITEM_SELECTOR}[data-wheel-item="lists"]`
    );
    btn?.classList.toggle('nn-wheel__item--active', listType !== null);
  }

  public getElement(): HTMLElement | null {
    return this.element;
  }

  public destroy(): void {
    this.element?.remove();
    this.element = null;
  }
}
