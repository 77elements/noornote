/**
 * AnalyticsAddonView — Pattern-B addon view: enable toggle + feature zone.
 *
 * Canonical markup (per addons skill): h1 → section.section > div.setting
 * (toggle) → div[data-addon-content="analytics"] (feature UI mount point).
 *
 * UX contract (user directive 2026-08-27): when enabled, the COMPLETE row
 * skeleton renders IMMEDIATELY — only the numeric tile values carry the
 * loading state (.pulsate). There is never a blocking whole-zone placeholder.
 * Cached snapshots paint instantly; collectors fill their tiles one by one
 * via `analytics:section-ready` as the run progresses.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { formatSatsCompact } from '../../helpers/zapUtils';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';
import { isAnalyticsEnabled, setAnalyticsEnabled } from './index';
import { AnalyticsService } from './AnalyticsService';
import type { CollectorId } from './collectors';

/** One stat tile: label + value slot, mapped to a metric key. */
interface TileSpec {
  /** DOM id within the zone (data-tile). */
  tile: string;
  label: string;
  /** Which collector feeds this tile. */
  collector: CollectorId;
  /** Metric key inside the collector's metrics (empty = filled later phase). */
  metric?: string;
  /** Value formatter (default: plain localized number). */
  format?: (value: number) => string;
}

interface RowSpec {
  row: string;
  title: string;
  tiles: TileSpec[];
  /** Optional footnote under the tiles (e.g. zaps best-effort note). */
  note?: string;
}

/** Format "1 : x.y" quotients; Infinity (replies without originals) → "—". */
const quotientFormat = (v: number): string =>
  Number.isFinite(v) ? `1 : ${v.toFixed(1)}` : '—';

/**
 * The five metric rows (posts / follow / content / zaps / engagement).
 * Tiles whose metric is not collected yet (P2–P5) simply keep their
 * loading state until their phase lands — the skeleton is final now.
 */
const ROWS: RowSpec[] = [
  {
    row: 'posts',
    title: 'Posts',
    tiles: [
      {
        tile: 'originals',
        label: 'Original notes',
        collector: 'posts',
        metric: 'originals',
      },
      {
        tile: 'replies-kind1',
        label: 'Replies (kind 1)',
        collector: 'posts',
        metric: 'repliesKind1',
      },
      {
        tile: 'comments-1111',
        label: 'Comments (kind 1111)',
        collector: 'posts',
        metric: 'comments1111',
      },
      {
        tile: 'replies-total',
        label: 'Replies + Comments',
        collector: 'posts',
        metric: 'repliesTotal',
      },
      {
        tile: 'posts-quotient',
        label: 'Originals : Replies',
        collector: 'posts',
        metric: 'quotient',
        format: quotientFormat,
      },
    ],
  },
  {
    row: 'follow',
    title: 'Follow',
    tiles: [
      {
        tile: 'follows',
        label: 'Follows',
        collector: 'follow',
        metric: 'follows',
      },
      {
        tile: 'followers',
        label: 'Followers',
        collector: 'follow',
        metric: 'followers',
      },
    ],
  },
  {
    row: 'content',
    title: 'Content',
    tiles: [
      {
        tile: 'articles',
        label: 'Articles',
        collector: 'content',
        metric: 'articles',
      },
      {
        tile: 'videos',
        label: 'Video posts',
        collector: 'content',
        metric: 'videos',
      },
      {
        tile: 'listings',
        label: 'Listings',
        collector: 'content',
        metric: 'listings',
      },
    ],
  },
  {
    row: 'zaps',
    title: 'Zaps',
    note: 'Sent zaps are best effort — zaps from wallets that omit the P tag on receipts may be missing.',
    tiles: [
      {
        tile: 'zaps-sent-count',
        label: 'Zaps sent',
        collector: 'zaps',
        metric: 'sentCount',
      },
      {
        tile: 'zaps-received-count',
        label: 'Zaps received',
        collector: 'zaps',
        metric: 'receivedCount',
      },
      {
        tile: 'zaps-sent-sats',
        label: 'Sent',
        collector: 'zaps',
        metric: 'sentSats',
        format: v => `${formatSatsCompact(v)} sats`,
      },
      {
        tile: 'zaps-received-sats',
        label: 'Received',
        collector: 'zaps',
        metric: 'receivedSats',
        format: v => `${formatSatsCompact(v)} sats`,
      },
      {
        tile: 'zaps-ratio',
        label: 'Sent : Received',
        collector: 'zaps',
        metric: 'satsRatio',
        format: quotientFormat,
      },
    ],
  },
  {
    row: 'engagement',
    title: 'Engagement',
    tiles: [
      {
        tile: 'replies-received',
        label: 'Replies received',
        collector: 'engagement',
        metric: 'repliesReceived',
      },
      {
        tile: 'reposts-received',
        label: 'Reposts',
        collector: 'engagement',
        metric: 'repostsReceived',
      },
      {
        tile: 'quotes-received',
        label: 'Quoted reposts',
        collector: 'engagement',
        metric: 'quotesReceived',
      },
    ],
  },
];

const LOADING_HTML =
  '<span class="analytics-tile__value analytics-tile__value--loading pulsate">Loading…</span>';

export class AnalyticsAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private eventSubscriptionId: string | null = null;
  private runFinishedSubscriptionId: string | null = null;
  private followersProgressSubscriptionId: string | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-analytics';
    this.render();
  }

  private render(): void {
    this.enableSwitch?.destroy();

    this.enableSwitch = new Switch({
      label: '',
      checked: isAnalyticsEnabled(),
      onChange: checked => {
        setAnalyticsEnabled(checked);
        TypedEventBus.getInstance().emit('analytics:addon-toggle', {
          enabled: checked,
        });
        ToastService.show(
          checked ? 'Analytics enabled' : 'Analytics disabled',
          'success'
        );
        this.renderContentZone();
      },
    });

    this.container.innerHTML = `
      <h1>Analytics</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Analytics</span>
          <div class="setting__control">${this.enableSwitch.render()}</div>
          <p class="setting__desc">Your personal Nostr stats — posts and replies, follows, content, zaps and engagement. Data is gathered relay-friendly, cached per account and refreshed incrementally.</p>
        </div>
      </section>
      <div data-addon-content="analytics"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    this.renderContentZone();
  }

  /**
   * Fill the feature zone. When enabled the FULL row skeleton renders
   * synchronously (no waiting, no whole-zone spinner) — only tile values
   * start in loading state. Cache + run fill them afterwards.
   */
  private renderContentZone(): void {
    this.detachEventSubscription();

    const zone = this.container.querySelector<HTMLElement>(
      '[data-addon-content="analytics"]'
    );
    if (!zone) return;

    if (!isAnalyticsEnabled()) {
      zone.innerHTML =
        '<p class="form__note">Enable Analytics to see your stats.</p>';
      return;
    }

    // Complete skeleton, immediately — this is the whole point.
    let html = '<div class="analytics">';
    html +=
      '<div class="l-spread analytics__meta">' +
      '<span class="small pulsate" data-analytics-updated>Loading…</span>' +
      '<button type="button" class="btn btn--passive btn--mini" data-analytics-refresh>Refresh</button>' +
      '</div>';
    for (const row of ROWS) {
      html += `<section class="analytics__row" data-analytics-row="${row.row}">`;
      html += `<h2 class="analytics__row-title">${row.title}</h2>`;
      html += '<div class="analytics-tiles">';
      for (const tile of row.tiles) {
        html +=
          `<div class="analytics-tile" data-tile="${tile.tile}">` +
          `<span class="analytics-tile__label small">${tile.label}</span>${
            LOADING_HTML
          }</div>`;
      }
      html += '</div>';
      if (row.note) {
        html += `<p class="form__note analytics__row-note">${row.note}</p>`;
      }
      html += '</section>';
    }
    html += '</div>';
    zone.innerHTML = html;

    const refreshBtn = zone.querySelector<HTMLButtonElement>(
      '[data-analytics-refresh]'
    );
    refreshBtn?.addEventListener('click', () =>
      this.onRefreshClick(refreshBtn)
    );

    void this.bootAnalytics(zone);
  }

  /** Load cache → paint instantly → subscribe → start background run. */
  private async bootAnalytics(zone: HTMLElement): Promise<void> {
    const service = AnalyticsService.getInstance();
    await service.ensureReady();

    // Zone may have been re-rendered while awaiting — re-query.
    const live = zone.isConnected
      ? zone
      : this.container.querySelector<HTMLElement>(
          '[data-addon-content="analytics"]'
        );
    if (!live) return;

    this.paintFirstRunNotice(live, service.isFirstRun());

    // Instant paint from cache (tiles without a cached value keep loading).
    let newest = 0;
    for (const row of ROWS) {
      const snapshot = service.getCachedSnapshot(row.tiles[0]!.collector);
      if (!snapshot) continue;
      this.fillRow(live, row, snapshot.metrics);
      if (snapshot.fetchedAt > newest) newest = snapshot.fetchedAt;
    }
    this.paintLastUpdated(live, newest, false);

    this.attachEventSubscription(live);

    // Background run refreshes/fills everything (first run = full sweep).
    void service.startRun().catch(() => {
      /* errors are diagLogged + surfaced via analytics:run-finished */
    });
  }

  private paintFirstRunNotice(zone: HTMLElement, firstRun: boolean): void {
    zone.querySelector('[data-analytics-first-run]')?.remove();
    if (!firstRun) return;
    const notice = document.createElement('p');
    notice.className = 'form__note analytics__first-run';
    notice.setAttribute('data-analytics-first-run', '');
    notice.textContent =
      'First initial run — gathering your data from relays. This takes a moment; subsequent visits load instantly from cache and refresh incrementally.';
    const skeleton = zone.querySelector('.analytics');
    if (skeleton) {
      skeleton.before(notice);
    } else {
      zone.prepend(notice);
    }
  }

  /** Fill all tiles of a row from a metrics record (missing keys stay loading). */
  private fillRow(
    zone: HTMLElement,
    row: RowSpec,
    metrics: Record<string, number>
  ): void {
    for (const tile of row.tiles) {
      if (!tile.metric) continue;
      const value = metrics[tile.metric];
      if (typeof value !== 'number') continue;
      this.setTileValue(zone, tile, value);
    }
  }

  private setTileValue(zone: HTMLElement, tile: TileSpec, value: number): void {
    const el = zone.querySelector<HTMLElement>(`[data-tile="${tile.tile}"]`);
    if (!el) return;
    const valueSlot = el.querySelector('.analytics-tile__value');
    if (!valueSlot) return;
    const formatted = tile.format
      ? tile.format(value)
      : value.toLocaleString('en-US');
    valueSlot.className = 'analytics-tile__value';
    valueSlot.textContent = formatted;
  }

  private attachEventSubscription(zone: HTMLElement): void {
    this.detachEventSubscription();
    const bus = TypedEventBus.getInstance();
    this.eventSubscriptionId = bus.on('analytics:section-ready', payload => {
      const row = ROWS.find(r =>
        r.tiles.some(t => t.collector === payload.collectorId)
      );
      // Always target the LIVE zone (view may have re-rendered since).
      const live = zone.isConnected
        ? zone
        : this.container.querySelector<HTMLElement>(
            '[data-addon-content="analytics"]'
          );
      if (!live) return;
      if (row) this.fillRow(live, row, payload.metrics);
      this.paintLastUpdated(live, payload.fetchedAt, true);
    });
    this.runFinishedSubscriptionId = bus.on('analytics:run-finished', () => {
      const live = zone.isConnected
        ? zone
        : this.container.querySelector<HTMLElement>(
            '[data-addon-content="analytics"]'
          );
      if (live) this.setRefreshState(live, false);
    });
    // Progressive follower count (PV semantics): `N+` pulsating while the
    // shared FollowerCountService sweep is still querying relays.
    this.followersProgressSubscriptionId = bus.on(
      'analytics:followers-progress',
      payload => {
        const live = zone.isConnected
          ? zone
          : this.container.querySelector<HTMLElement>(
              '[data-addon-content="analytics"]'
            );
        if (live) this.paintFollowersProgress(live, payload.count);
      }
    );
  }

  /** Followers tile while sweeping: `N+` pulsating (count 0 → keep loading). */
  private paintFollowersProgress(zone: HTMLElement, count: number): void {
    if (count <= 0) return;
    const el = zone.querySelector<HTMLElement>('[data-tile="followers"]');
    if (!el) return;
    const valueSlot = el.querySelector('.analytics-tile__value');
    if (!valueSlot) return;
    valueSlot.className = 'analytics-tile__value pulsate';
    valueSlot.textContent = `${count.toLocaleString('en-US')}+`;
  }

  /** Refresh forces a full run (heals deletion drift via since-cursor reset). */
  private onRefreshClick(button: HTMLButtonElement): void {
    if (button.disabled) return;
    this.setRefreshState(
      button.closest('[data-addon-content="analytics"]') as HTMLElement,
      true
    );
    void AnalyticsService.getInstance()
      .startRun({ forceFull: true })
      .catch(() => {
        /* failures are diagLogged per collector */
      });
  }

  private setRefreshState(zone: HTMLElement | null, running: boolean): void {
    if (!zone) return;
    const btn = zone.querySelector<HTMLButtonElement>(
      '[data-analytics-refresh]'
    );
    if (!btn) return;
    btn.disabled = running;
    btn.textContent = running ? 'Refreshing…' : 'Refresh';
    btn.classList.toggle('pulsate', running);
  }

  /** Keep the newest "Last updated" stamp; 0 → loading placeholder. */
  private paintLastUpdated(
    zone: HTMLElement,
    fetchedAt: number,
    mergeWithExisting: boolean
  ): void {
    const el = zone.querySelector<HTMLElement>('[data-analytics-updated]');
    if (!el) return;
    const current = Number(el.getAttribute('data-ts') || 0);
    const newest = mergeWithExisting ? Math.max(current, fetchedAt) : fetchedAt;
    if (!newest) return;
    el.setAttribute('data-ts', String(newest));
    el.textContent = `Last updated ${formatTimeAgo(newest)}`;
    el.classList.remove('pulsate');
  }

  private detachEventSubscription(): void {
    const bus = TypedEventBus.getInstance();
    if (this.eventSubscriptionId !== null) {
      bus.off(this.eventSubscriptionId);
      this.eventSubscriptionId = null;
    }
    if (this.runFinishedSubscriptionId !== null) {
      bus.off(this.runFinishedSubscriptionId);
      this.runFinishedSubscriptionId = null;
    }
    if (this.followersProgressSubscriptionId !== null) {
      bus.off(this.followersProgressSubscriptionId);
      this.followersProgressSubscriptionId = null;
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.detachEventSubscription();
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.container.innerHTML = '';
  }
}
