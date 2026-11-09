/**
 * LiveStreamsAddonView
 *
 * View for the Live Streams addon page (`/addons/live-streams`): enable
 * toggle on top, then — while the addon is enabled — the sidebar-widget
 * switch and the list of currently running NIP-53 live streams
 * (zap.stream et al.), paged via infinite scroll, newest first.
 * Clicking a stream opens the dedicated detail route
 * `/addons/live-streams/stream/<naddr>` (inline player, not an SNV).
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { InfiniteScroll } from '../../components/ui/InfiniteScroll';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { Router } from '../../services/Router';
import { UserProfileService } from '../../services/UserProfileService';
import {
  escapeHtml,
  escapeHtmlAttr,
  safeHttpUrl,
} from '../../helpers/escapeHtml';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';
import { AddonLoader } from '../AddonLoader';
import {
  isLiveStreamsEnabled,
  setLiveStreamsEnabled,
  isLiveStreamsSidebarWidget,
  setLiveStreamsSidebarWidget,
} from './index';
import { fetchLiveStreamsPage, type LiveStreamItem } from './streams';
import type { LiveStreamsRuntime } from './runtime';
import { _ } from '../../i18n';

const PAGE_SIZE = 20;

export class LiveStreamsAddonView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private enableSwitch: Switch | null = null;
  private widgetSwitch: Switch | null = null;
  private infiniteScroll: InfiniteScroll | null = null;
  private toggleSubId: string | null = null;
  /** Live-updates author names when profile fetches resolve (npub-fallback patch). */
  private profileUnsub: (() => void) | null = null;

  /** Paged-list state */
  private seen = new Set<string>();
  private nextUntil: number | undefined;
  private loading = false;
  private hasEnded = false;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-live-streams';

    const enabled = isLiveStreamsEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: checked => {
        setLiveStreamsEnabled(checked);
        TypedEventBus.getInstance().emit('live-streams:addon-toggle', {
          enabled: checked,
        });
        ToastService.show(
          checked
            ? _('%s enabled', _('Live Streams'))
            : _('%s disabled', _('Live Streams')),
          'success'
        );
        if (checked) void this.mountContent();
        else this.unmountContent();
      },
    });

    this.container.innerHTML = `
      <div class="back-padder">
        <h1>${_('Live Streams')}</h1>
        <section class="section">
          <div class="setting">
            <span class="setting__label">${_('Enable Live Streams')}</span>
            <div class="setting__control"></div>
            <p class="setting__desc">${_('Play NIP-53 live streams inline right from the timeline, no need to leave NoorNote. Uses hls.js; large providers like zap.stream are supported out of the box. Currently running streams are listed below.')}</p>
          </div>
        </section>
        <div data-addon-content="livestreams"></div>
      </div>
    `;
    const controlEl = this.container.querySelector('.setting__control');
    if (controlEl) controlEl.innerHTML = this.enableSwitch.render();
    this.enableSwitch.setupEventListeners(this.container);

    this.contentEl = this.container.querySelector(
      '[data-addon-content="livestreams"]'
    );

    if (enabled) {
      void this.mountContent();
    }

    this.toggleSubId = TypedEventBus.getInstance().on(
      'live-streams:addon-toggle',
      (payload: { enabled: boolean }) => {
        if (payload.enabled) void this.mountContent();
        else this.unmountContent();
      }
    );

    // Card → detail route (delegated, survives re-renders)
    this.container.addEventListener('click', this.onCardClick);

    // Patch author names in place when profile fetches resolve — the display
    // rule forbids leaving shortened npub placeholders in the UI.
    this.profileUnsub =
      UserProfileService.getInstance().subscribeToAnyProfileUpdate(
        (pubkey, profile) => {
          const name = UserProfileService.displayNameOf(profile, pubkey);
          this.container
            .querySelectorAll<HTMLElement>(
              `.live-streams-card__author[data-host="${pubkey}"]`
            )
            .forEach(el => {
              el.textContent = name;
            });
        }
      );
  }

  private onCardClick = (e: MouseEvent): void => {
    const card = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-naddr]'
    );
    if (!card) return;
    e.preventDefault();
    Router.getInstance().navigate(
      `/addons/live-streams/stream/${card.dataset.naddr}`
    );
  };

  private async mountContent(): Promise<void> {
    if (!this.contentEl || this.contentEl.childElementCount > 0) return;

    this.contentEl.innerHTML = `
      <section class="section">
        <div class="setting">
          <span class="setting__label">${_('Show Live Streams Widget')}</span>
          <div class="setting__control" data-widget-switch-mount></div>
          <p class="setting__desc">${_('Show a widget in the sidebar with the currently-live streams of people you follow (max 3). The widget is hidden when nobody you follow is live.')}</p>
        </div>
      </section>
      <section class="section">
        <h2 class="live-streams-list__heading">${_('Currently live')}</h2>
        <div class="nn-card-grid-wrap" data-streams-wrap>
          <div class="nn-card-grid" data-streams-grid></div>
        </div>
        <p class="live-streams-list__empty" data-streams-empty hidden>${_('No live streams found.')}</p>
      </section>
    `;

    this.setupWidgetSwitch();

    // Reset page state (view can be re-mounted after toggle cycles)
    this.seen = new Set();
    this.nextUntil = undefined;
    this.loading = false;
    this.hasEnded = false;

    this.infiniteScroll = new InfiniteScroll(() => void this.loadMore(), {
      loadingMessage: _('Loading more streams...'),
    });
    const wrap = this.contentEl.querySelector('[data-streams-wrap]');
    if (wrap) this.infiniteScroll.observe(wrap as HTMLElement);

    await this.loadMore();
  }

  private setupWidgetSwitch(): void {
    const mount = this.contentEl?.querySelector('[data-widget-switch-mount]');
    if (!mount) return;

    this.widgetSwitch = new Switch({
      label: '',
      checked: isLiveStreamsSidebarWidget(),
      onChange: checked => {
        setLiveStreamsSidebarWidget(checked);
        AddonLoader.getInstance()
          .getRuntime<LiveStreamsRuntime>('live-streams')
          ?.widget?.refresh();
      },
    });
    mount.innerHTML = this.widgetSwitch.render();
    this.widgetSwitch.setupEventListeners(this.contentEl as HTMLElement);
  }

  private async loadMore(): Promise<void> {
    if (this.loading || this.hasEnded || !this.contentEl) return;
    this.loading = true;
    this.infiniteScroll?.showLoading();

    try {
      const page = await fetchLiveStreamsPage({
        limit: PAGE_SIZE,
        ...(this.nextUntil !== undefined ? { until: this.nextUntil } : {}),
        seen: this.seen,
      });

      if (page.nextUntil === null) {
        this.hasEnded = true;
        this.infiniteScroll?.disconnect();
      } else {
        this.nextUntil = page.nextUntil;
      }

      // Live-only list: ended/planned streams are dropped. Actively-live
      // streams bump their created_at constantly, so they sit on the newest
      // pages — a page without any live item means nothing further back is
      // live either → stop paging.
      const liveItems = page.items.filter(item => item.status === 'live');
      if (liveItems.length > 0) this.appendCards(liveItems);
      if (liveItems.length === 0) {
        this.hasEnded = true;
        this.infiniteScroll?.disconnect();
      }

      const grid = this.contentEl.querySelector('[data-streams-grid]');
      const empty = this.contentEl.querySelector('[data-streams-empty]');
      if (empty instanceof HTMLElement) {
        empty.hidden = (grid?.childElementCount ?? 0) > 0;
      }
    } catch {
      ToastService.show(_('Failed to load live streams'), 'error');
      this.hasEnded = true;
    } finally {
      this.loading = false;
      this.infiniteScroll?.hideLoading();
      this.infiniteScroll?.refresh();
    }
  }

  private appendCards(items: LiveStreamItem[]): void {
    const grid = this.contentEl?.querySelector('[data-streams-grid]');
    if (!grid) return;

    const profiles = UserProfileService.getInstance();
    const statusLabel = (status: LiveStreamItem['status']): string =>
      status === 'live'
        ? _('Live')
        : status === 'ended'
          ? _('Ended')
          : _('Planned');

    for (const item of items) {
      const card = document.createElement('article');
      card.className = `nn-card live-streams-card live-streams-card--${item.status}`;
      card.dataset.naddr = item.naddr;

      const image = safeHttpUrl(item.image);
      card.innerHTML = `
        ${
          image
            ? `
          <div class="nn-card__media">
            <img src="${escapeHtmlAttr(image)}" alt="${escapeHtmlAttr(item.title || _('Untitled Stream'))}" loading="lazy" />
            <span class="live-streams-card__badge">${statusLabel(item.status)}</span>
          </div>
        `
            : `
          <div class="nn-card__media nn-card__media--empty live-streams-card__media--placeholder">
            <svg width="28" height="28"><use href="#icon-play"/></svg>
            <span class="live-streams-card__badge">${statusLabel(item.status)}</span>
          </div>
        `
        }
        <div class="nn-card__content">
          <h3 class="title">${escapeHtml(item.title || _('Untitled Stream'))}</h3>
          <p class="meta author live-streams-card__author" data-host="${escapeHtmlAttr(item.host)}">${escapeHtml(profiles.getDisplayName(item.host))}</p>
          <p class="meta">${_('Started %s', formatTimeAgo(item.createdAt * 1000))}</p>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  private unmountContent(): void {
    this.widgetSwitch?.destroy();
    this.widgetSwitch = null;
    this.infiniteScroll?.destroy();
    this.infiniteScroll = null;
    this.seen = new Set();
    this.nextUntil = undefined;
    this.hasEnded = false;
    if (this.contentEl) this.contentEl.innerHTML = '';
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      TypedEventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    this.profileUnsub?.();
    this.profileUnsub = null;
    this.container.removeEventListener('click', this.onCardClick);
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.unmountContent();
    this.contentEl = null;
    this.container.innerHTML = '';
  }
}
