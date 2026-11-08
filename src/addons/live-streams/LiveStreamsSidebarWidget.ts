/**
 * LiveStreamsSidebarWidget — "currently live" widget in the left sidebar.
 *
 * Mounts into the static sidebar slot `[data-sidebar-widget="live-streams"]`
 * (MainLayout, next to the BTC price / Nostr Majlis widgets) when the sidebar
 * widget setting is on. Shows up to 3 currently-live streams of followed users
 * as mini cards (avatar | title + "Started x ago" | live diode).
 *
 * IMPORTANT: when no followed user is live, the widget renders NOTHING —
 * an empty sidebar slot instead of a placeholder, even with the setting on.
 *
 * Refreshes every 2 min; owned by the runtime so the interval, DOM and
 * listeners are cleared on toggle / logout / account switch.
 */

import { fetchLiveStreamsPage } from './streams';
import { isLiveStreamsSidebarWidget } from './index';
import { getAllFollowedPubkeys } from '../../lists/follows';
import { UserProfileService } from '../../services/UserProfileService';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { _ } from '../../i18n';

const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const MAX_ITEMS = 3;

export interface LiveStreamsSidebarWidgetOptions {
  container: () => HTMLElement | null;
  visible: () => boolean;
}

export class LiveStreamsSidebarWidget {
  private opts: LiveStreamsSidebarWidgetOptions;
  private el: HTMLElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching = false;
  private destroyed = false;
  /** Patches avatar images in place when profile fetches resolve. */
  private profileUnsub: (() => void) | null = null;

  constructor(opts: LiveStreamsSidebarWidgetOptions) {
    this.opts = opts;
  }

  public mount(): void {
    this.start();
  }

  /** Re-fetch + re-render (also used by the addon view after setting changes). */
  public refresh(): void {
    void this.render();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.render(), REFRESH_INTERVAL_MS);
    this.profileUnsub =
      UserProfileService.getInstance().subscribeToAnyProfileUpdate(
        (pubkey, profile) => {
          const picture = UserProfileService.displayPictureOf(profile, pubkey);
          this.el
            ?.querySelectorAll<HTMLImageElement>(
              `.live-streams-widget__avatar[data-host="${pubkey}"]`
            )
            .forEach(img => {
              img.src = picture;
            });
        }
      );
    void this.render();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.profileUnsub?.();
    this.profileUnsub = null;
  }

  private async render(): Promise<void> {
    if (this.destroyed) return;

    if (!this.opts.visible() || !isLiveStreamsSidebarWidget()) {
      this.teardownDom();
      return;
    }

    if (this.fetching) return;
    this.fetching = true;

    try {
      const followed = new Set(getAllFollowedPubkeys());
      if (followed.size === 0) {
        this.teardownDom();
        return;
      }

      const { items } = await fetchLiveStreamsPage({ limit: 50 });
      const live = items
        .filter(item => item.status === 'live' && followed.has(item.host))
        .slice(0, MAX_ITEMS);

      if (this.destroyed) return;
      if (live.length === 0) {
        this.teardownDom();
        return;
      }

      this.renderItems(live);
    } catch {
      // Fetch failed (relay timeout etc.) — keep the previous state as-is.
    } finally {
      this.fetching = false;
    }
  }

  private renderItems(items: Array<import('./streams').LiveStreamItem>): void {
    const container = this.opts.container();
    if (!container) return;

    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'sidebar-widget live-streams-widget';
      container.appendChild(this.el);
    }

    const profiles = UserProfileService.getInstance();
    this.el.innerHTML = items
      .map(
        item => `
        <a class="live-streams-widget__item" href="/addons/live-streams/stream/${escapeHtmlAttr(item.naddr)}">
          <img class="live-streams-widget__avatar" data-host="${escapeHtmlAttr(item.host)}" src="${escapeHtmlAttr(profiles.getDisplayPicture(item.host))}" alt="" />
          <span class="live-streams-widget__info">
            <span class="live-streams-widget__title">${escapeHtml(item.title || _('Untitled Stream'))}</span>
            <span class="live-streams-widget__started">${_('Started %s', formatTimeAgo(item.createdAt * 1000))}</span>
          </span>
          <span class="live-streams-widget__status">
            <span class="live-streams-widget__diode"></span>
            <span class="live-streams-widget__status-label">${_('Live')}</span>
          </span>
        </a>
      `
      )
      .join('');
  }

  private teardownDom(): void {
    this.el?.remove();
    this.el = null;
  }

  public destroy(): void {
    this.destroyed = true;
    this.stop();
    this.teardownDom();
  }
}
