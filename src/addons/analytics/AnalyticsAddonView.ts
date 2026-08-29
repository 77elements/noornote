/**
 * AnalyticsAddonView — Pattern-B addon view: enable toggle + feature zone.
 *
 * Canonical markup (per addons skill): h1 → section.section > div.setting
 * (toggle) → tabs bar → div[data-addon-content="overview" | "top-posts"]
 *
 * UX contract (user directive 2026-08-27): when enabled, the COMPLETE row
 * skeleton renders IMMEDIATELY — only the numeric tile values carry the
 * loading state (.pulsate). There is never a blocking whole-zone placeholder.
 * Cached snapshots paint instantly; collectors fill their tiles one by one
 * via `analytics:section-ready` as the run progresses.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { Tooltip } from '../../components/ui/Tooltip';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { Router } from '../../services/Router';
import {
  setupTabClickHandlers,
  switchTabWithContent,
} from '../../helpers/TabsHelper';
import { escapeHtml } from '../../helpers/escapeHtml';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { formatSatsCompact } from '../../helpers/zapUtils';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';
import { isAnalyticsEnabled, setAnalyticsEnabled } from './index';
import { AnalyticsService } from './AnalyticsService';
import type { CollectorId } from './collectors';
import {
  engagementScore,
  type EngagementBucket,
  type EngagementUnit,
  type TopPostEntry,
} from './analyticsLogic';

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
  /** Start on a fresh tile-grid line instead of flowing after the previous tile. */
  newLine?: boolean;
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
 * The four metric rows (content (posts+articles/videos/products) / follow /
 * zaps / engagement). The content tiles (articles/videos/listings) flow into
 * the former Posts row as a second tile line, the whole section is titled
 * "Content" (user directive 2026-08-29). The 'content' collector still feeds
 * its tiles via `analytics:section-ready`; rows may span multiple collectors.
 * Tiles whose metric is not collected yet keep their loading state.
 */
const ROWS: RowSpec[] = [
  {
    row: 'posts',
    title: 'Content',
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
      {
        tile: 'articles',
        label: 'Articles',
        collector: 'content',
        metric: 'articles',
        newLine: true,
      },
      {
        tile: 'videos',
        label: 'Video posts',
        collector: 'content',
        metric: 'videos',
      },
      {
        tile: 'listings',
        label: 'Products',
        collector: 'content',
        metric: 'listings',
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
      {
        tile: 'likes-received',
        label: 'Likes',
        collector: 'engagement',
        metric: 'likesReceived',
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
  private engagementTooltipDisposers: (() => void)[] = [];

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
          <p class="setting__desc">Your personal Nostr stats — posts and replies, follows, content, zaps and engagement. Data is gathered relay-friendly, cached per account and refreshed incrementally. Counts cover your entire history — all-time, not a fixed window, as far as relay retention allows.</p>
        </div>
      </section>
      <div class="tabs tabs--scrollable" data-el="analytics-tabs" hidden>
        <button class="tab tab--active" data-tab="overview">Overview</button>
        <button class="tab" data-tab="top-posts">Top Posts</button>
        <button class="tab" data-tab="diagrams">Diagrams</button>
      </div>
      <div class="tab-content tab-content--active" data-tab-content="overview" data-addon-content="overview"></div>
      <div class="tab-content" data-tab-content="top-posts" data-addon-content="top-posts"></div>
      <div class="tab-content" data-tab-content="diagrams" data-addon-content="diagrams"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    setupTabClickHandlers(this.container, tabId =>
      switchTabWithContent(this.container, tabId)
    );
    this.renderContentZone();
  }

  /** Live query helpers — panes are re-rendered, this.container is stable. */
  private overviewZone(): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(
      '[data-addon-content="overview"]'
    );
  }

  private topPostsZone(): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(
      '[data-addon-content="top-posts"]'
    );
  }

  private diagramsZone(): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(
      '[data-addon-content="diagrams"]'
    );
  }

  /**
   * Fill the feature panes. When enabled, both tabs render their complete
   * skeleton synchronously (no waiting, no whole-zone spinner) — tile values
   * and the list start in loading state. Cache + run fill them afterwards.
   */
  private renderContentZone(): void {
    this.detachEventSubscription();

    const tabsBar = this.container.querySelector<HTMLElement>(
      '[data-el="analytics-tabs"]'
    );
    const overview = this.overviewZone();
    const topZone = this.topPostsZone();
    const diagrams = this.diagramsZone();
    if (!overview || !topZone || !diagrams) return;

    if (!isAnalyticsEnabled()) {
      if (tabsBar) tabsBar.hidden = true;
      const note =
        '<p class="form__note">Enable Analytics to see your stats.</p>';
      overview.innerHTML = note;
      topZone.innerHTML = note;
      diagrams.innerHTML = note;
      return;
    }
    if (tabsBar) tabsBar.hidden = false;

    // Complete skeleton, immediately — this is the whole point. Wrapped in a
    // <section> so the `.tab-content > section` padding rule applies uniformly
    // across all tabs.
    let html = '<section><div class="analytics">';
    html +=
      '<div class="l-row--right analytics__meta">' +
      '<span class="small pulsate" data-analytics-updated>Loading…</span>' +
      '<button type="button" class="btn btn--passive btn--mini" data-analytics-refresh>Refresh</button>' +
      '</div>';
    for (const row of ROWS) {
      html += `<section class="analytics__row" data-analytics-row="${row.row}">`;
      html += `<h2 class="analytics__row-title">${row.title}</h2>`;
      html += '<div class="analytics-tiles">';
      for (const tile of row.tiles) {
        html +=
          `<div class="analytics-tile${tile.newLine ? ' analytics-tile--row-break' : ''}" data-tile="${tile.tile}">` +
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
    html += '</div></section>';
    overview.innerHTML = html;

    topZone.innerHTML = `
      <section class="analytics__row" data-analytics-row="top-posts">
        <ul class="ui-list" data-top-posts-list>
          <li class="ui-list__item"><span class="small pulsate">Ranking your posts…</span></li>
        </ul>
      </section>`;

    diagrams.innerHTML = `
      <section class="analytics__row" data-analytics-row="engagement-timeline">
        <h2 class="analytics__row-title">Engagement over time</h2>
        <p class="form__note">Received engagement per bucket — replies, zaps, reposts, quotes and likes combined, same components as the Top Posts ranking. Hover a bar for the breakdown.</p>
        <div class="analytics-chart" data-engagement-chart>
          <p class="form__note pulsate">Building your engagement curve…</p>
        </div>
      </section>`;

    const refreshBtn = overview.querySelector<HTMLButtonElement>(
      '[data-analytics-refresh]'
    );
    refreshBtn?.addEventListener('click', () =>
      this.onRefreshClick(refreshBtn)
    );

    const topList = topZone.querySelector('[data-top-posts-list]');
    topList?.addEventListener('click', e => this.onTopPostClick(e));

    void this.bootAnalytics();
  }

  /** Top-post item click → SNV of the own post (canonical bare-nevent form). */
  private onTopPostClick(e: Event): void {
    const item = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-top-post-id]'
    );
    if (!item) return;
    const id = item.dataset.topPostId;
    if (!id) return;
    Router.getInstance().navigate(`/note/${encodeNevent(id)}`);
  }

  /** Load cache → paint instantly → subscribe → start background run. */
  private async bootAnalytics(): Promise<void> {
    const service = AnalyticsService.getInstance();
    await service.ensureReady();

    // Panes may have been re-rendered while awaiting — re-query.
    const live = this.overviewZone();
    if (!live) return;

    this.paintFirstRunNotice(live, service.isFirstRun());

    // Instant paint from cache (tiles without a cached value keep loading).
    // A row may span multiple collectors (posts+content) — paint per collector.
    let newest = 0;
    const painted = new Set<CollectorId>();
    for (const row of ROWS) {
      for (const tile of row.tiles) {
        if (painted.has(tile.collector)) continue;
        painted.add(tile.collector);
        const snapshot = service.getCachedSnapshot(tile.collector);
        if (!snapshot) continue;
        this.fillRow(live, row, snapshot.metrics);
        if (snapshot.fetchedAt > newest) newest = snapshot.fetchedAt;
      }
    }
    const topSnapshot = service.getCachedSnapshot('top-posts');
    if (topSnapshot?.aux?.topPosts) {
      this.paintTopPosts(topSnapshot.aux.topPosts);
      if (topSnapshot.fetchedAt > newest) newest = topSnapshot.fetchedAt;
    }
    const timelineSnapshot = service.getCachedSnapshot('engagement-timeline');
    if (timelineSnapshot?.aux?.timeline && timelineSnapshot.aux.timelineUnit) {
      this.paintEngagementChart(
        timelineSnapshot.aux.timeline,
        timelineSnapshot.aux.timelineUnit
      );
    }
    this.paintLastUpdated(live, newest, false);

    this.attachEventSubscription();

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

  /**
   * Render the ranked top-posts list (top 10 of the capped snapshot).
   * Snippets are plain-text-ish (whitespace collapsed) and escapeHtml'd —
   * event content is untrusted. Each item links to its SNV.
   */
  private paintTopPosts(posts: TopPostEntry[]): void {
    const list = this.topPostsZone()?.querySelector<HTMLElement>(
      '[data-top-posts-list]'
    );
    if (!list) return;
    if (!posts.length) {
      list.innerHTML =
        '<li class="ui-list__item"><span class="small">No own posts found yet.</span></li>';
      return;
    }
    list.innerHTML = posts
      .slice(0, 10)
      .map((p, i) => {
        const snippet = escapeHtml(
          (p.content.replace(/\s+/g, ' ').trim() || '(no text content)').slice(
            0,
            160
          )
        );
        const stats = [
          {
            icon: 'icon-reply',
            label: 'Replies',
            value: String(p.replies),
          },
          {
            icon: 'icon-zap',
            label:
              p.zapSats > 0
                ? `Zaps · ${formatSatsCompact(p.zapSats)} sats`
                : 'Zaps',
            value: String(p.zaps),
          },
          {
            icon: 'icon-repost',
            label: 'Reposts & quotes',
            value: String(p.reposts + p.quotes),
          },
          { icon: 'icon-heart', label: 'Likes', value: String(p.likes) },
        ]
          .map(
            s =>
              `<span class="analytics-top__stat" title="${s.label}">` +
              `<svg width="14" height="14" aria-hidden="true"><use href="#${s.icon}"/></svg>` +
              `${s.value}</span>`
          )
          .join('');
        return (
          `<li class="ui-list__item ui-list__item--clickable analytics-top__item" data-top-post-id="${p.id}">` +
          `<span class="analytics-top__rank">${i + 1}</span>` +
          `<div class="analytics-top__body">` +
          `<span class="analytics-top__snippet">${snippet}</span>` +
          `<span class="analytics-top__meta small">${formatTimeAgo(p.createdAt * 1000)}</span>` +
          `</div>` +
          `<div class="analytics-top__stats">${stats}</div>` +
          `</li>`
        );
      })
      .join('');
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

  /**
   * Render the engagement curve as CSS bars (no chart SDK). One column per
   * bucket, height ∝ score (same components as the Top-Posts ranking);
   * every bar carries a Tooltip with the per-component breakdown.
   */
  private paintEngagementChart(
    timeline: EngagementBucket[],
    unit: EngagementUnit
  ): void {
    const chart = this.diagramsZone()?.querySelector<HTMLElement>(
      '[data-engagement-chart]'
    );
    if (!chart) return;
    this.engagementTooltipDisposers.forEach(dispose => dispose());
    this.engagementTooltipDisposers = [];

    if (!timeline.length) {
      chart.innerHTML =
        '<p class="form__note">No engagement data yet — run a Refresh.</p>';
      return;
    }

    const max = Math.max(...timeline.map(engagementScore), 1);
    const labelEvery = Math.max(1, Math.ceil(timeline.length / 8));
    let bars = '';
    let labels = '';
    timeline.forEach((bucket, i) => {
      const height = Math.max(
        2,
        Math.round((engagementScore(bucket) / max) * 100)
      );
      bars += `<div class="analytics-chart__col"><div class="analytics-chart__bar" data-bucket="${i}" style="height:${height}%"></div></div>`;
      if (i % labelEvery === 0) {
        labels += `<span class="analytics-chart__label" style="grid-column:${i + 1}">${this.formatBucketLabel(bucket.start, unit)}</span>`;
      }
    });
    chart.innerHTML =
      `<div class="analytics-chart__plot">${bars}</div>` +
      `<div class="analytics-chart__axis" style="grid-template-columns:repeat(${timeline.length},minmax(0,1fr))">${labels}</div>`;

    timeline.forEach((bucket, i) => {
      const bar = chart.querySelector<HTMLElement>(`[data-bucket="${i}"]`);
      if (!bar) return;
      const breakdown =
        `${bucket.replies} replies, ${bucket.zaps} zaps, ` +
        `${bucket.reposts + bucket.quotes} reposts/quotes, ${bucket.likes} likes`;
      this.engagementTooltipDisposers.push(
        Tooltip.attach(
          bar,
          `${this.formatBucketLabel(bucket.start, unit, true)} — ${engagementScore(bucket)} engagement (${breakdown})`,
          { placement: 'top' }
        )
      );
    });
  }

  private formatBucketLabel(
    start: number,
    unit: EngagementUnit,
    withYear = false
  ): string {
    const date = new Date(start * 1000);
    if (unit === 'day' || unit === 'week') {
      return date.toLocaleDateString('en-US', {
        day: 'numeric',
        month: 'short',
        ...(withYear ? { year: 'numeric' } : {}),
      });
    }
    return date.toLocaleDateString('en-US', {
      month: 'short',
      year: unit === 'quarter' ? 'numeric' : '2-digit',
      ...(withYear ? { year: 'numeric' } : {}),
    });
  }

  private attachEventSubscription(): void {
    this.detachEventSubscription();
    const bus = TypedEventBus.getInstance();
    this.eventSubscriptionId = bus.on('analytics:section-ready', payload => {
      if (payload.collectorId === 'top-posts') {
        const snap =
          AnalyticsService.getInstance().getCachedSnapshot('top-posts');
        if (snap?.aux?.topPosts) this.paintTopPosts(snap.aux.topPosts);
      } else if (payload.collectorId === 'engagement-timeline') {
        const snap = AnalyticsService.getInstance().getCachedSnapshot(
          'engagement-timeline'
        );
        if (snap?.aux?.timeline && snap.aux.timelineUnit) {
          this.paintEngagementChart(snap.aux.timeline, snap.aux.timelineUnit);
        }
      } else {
        const live = this.overviewZone();
        if (!live) return;
        const row = ROWS.find(r =>
          r.tiles.some(t => t.collector === payload.collectorId)
        );
        if (row) this.fillRow(live, row, payload.metrics);
        this.paintLastUpdated(live, payload.fetchedAt, true);
      }
    });
    this.runFinishedSubscriptionId = bus.on('analytics:run-finished', () => {
      const live = this.overviewZone();
      if (live) this.setRefreshState(live, false);
    });
    // Progressive follower count (PV semantics): `N+` pulsating while the
    // shared FollowerCountService sweep is still querying relays.
    this.followersProgressSubscriptionId = bus.on(
      'analytics:followers-progress',
      payload => {
        const live = this.overviewZone();
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
    this.setRefreshState(this.overviewZone(), true);
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
    this.engagementTooltipDisposers.forEach(dispose => dispose());
    this.engagementTooltipDisposers = [];
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.container.innerHTML = '';
  }
}
