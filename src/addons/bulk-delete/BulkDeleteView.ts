/**
 * BulkDeleteView — addon page for `/addons/bulk-delete`.
 *
 * Lists the user's own posts (one-line, chronological, loadMore), lets them tick
 * the ones to delete and fire one NIP-09 deletion per ~100 selected (chunked →
 * low relay load). Deletion runs through the posts module + the resumable
 * delete-broadcast in SILENT mode: no System Log output, progress is shown on
 * this page instead.
 *
 * Two ways to scope the list, applied as orthogonal filters:
 *   - "Select time range" → windowed FeedOrchestrator fetch (all post kinds).
 *   - "Select by search term" → reuses the profile module's whole-history note
 *     search (kind 1 only) as the base set; a time range then narrows those
 *     loaded results client-side (no re-fetch).
 *
 * Row click opens the original note via ViewNavigationController.openView, i.e.
 * the standard app behavior (scc tab in right-pane mode, main column otherwise).
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { ModalService } from '../../services/ModalService';
import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../services/SystemLogger';
import { ModuleLoader } from '../../core/ModuleLoader';
import { escapeHtml } from '../../helpers/escapeHtml';
import { encodeNevent } from '../../helpers/encodeNevent';
import { truncateNoteContent } from '../../helpers/truncateNoteContent';
import { extractMedia } from '../../helpers/extractMedia';
import {
  pickDateRange,
  type DateRangeResult,
} from '../../helpers/datePickerModal';
import { InfiniteScroll } from '../../components/ui/InfiniteScroll';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import type { TimelineConfig } from '../../components/timeline/TimelineConfig';
import { isBulkDeleteEnabled, setBulkDeleteEnabled } from './index';
import type { TimelineModuleApi } from '../../modules/timeline/contracts';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import type { SingleNoteModuleApi } from '../../modules/single-note/contracts';
import type { BroadcastProgress } from '../../services/BroadcastDeleteService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

/** Selected notes are deleted in chunks of this many NIP-09 e-tags per kind:5. */
const CHUNK_SIZE = 100;
const PREVIEW_LEN = 90;
/** Keep the loaded list this long so re-opening (or a reload) doesn't force a re-search. */
const CACHE_TTL_MS = 30 * 60 * 1000;
/** sessionStorage key — survives reloads, clears when the tab is closed. */
const SESSION_KEY = 'noornote_bulk_delete_session';
/** Bump to invalidate caches written by an older (e.g. mis-ordered) version. */
const CACHE_VERSION = 3;

/** Slim, JSON-safe event (NDK events carry circular relay refs that can't be stringified). */
interface SlimEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}

interface BulkDeleteCache {
  version: number;
  pubkey: string;
  range: DateRangeResult | null; // null = the default "recent posts" view
  searchTerms: string | null; // non-null = search mode (searchBase holds the whole-history results)
  searchBase: SlimEvent[]; // full kind-1 search result; only populated in search mode
  notes: SlimEvent[]; // the date-mode list; empty in search mode (re-derived from searchBase)
  selected: string[];
  hasMore: boolean;
  savedAt: number;
}

export class BulkDeleteView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private enableSwitch: Switch | null = null;
  private toggleSubId: string | null = null;

  private range: DateRangeResult | null = null;
  private notes: NostrEvent[] = [];
  private selected = new Set<string>();
  private loading = false;
  private hasMore = false;
  private infiniteScroll: InfiniteScroll | null = null;

  // Search mode: null = date mode; set = whole-history kind-1 search active.
  private searchTerms: string | null = null;
  // Full search result; `notes` is this list optionally narrowed by `range`.
  private searchBase: NostrEvent[] = [];
  // Bumped by every load/search so a slow, superseded fetch can't clobber newer results.
  private loadSeq = 0;

  // Deletion progress state (aggregate from BroadcastDeleteService + live host events)
  private dispatching = false; // the deleteEvents() loop is running
  private deleteNoteCount = 0; // 0 = unknown (reconnected to a job from a prior view)
  private justCompleted = false;
  private summary: { total: number; contacted: number; sent: number } | null =
    null;
  private lastHost: { host: string; ok: boolean } | null = null;
  private progressRaf = 0;
  private pollTimer = 0;
  private progressUnsub: (() => void) | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-bulk-delete';

    const enabled = isBulkDeleteEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: checked => {
        setBulkDeleteEnabled(checked);
        TypedEventBus.getInstance().emit('bulk-delete:addon-toggle', {
          enabled: checked,
        });
        ToastService.show(
          checked ? 'Bulk delete enabled' : 'Bulk delete disabled',
          'success'
        );
        if (checked) this.mountContent();
        else this.unmountContent();
      },
    });

    this.container.innerHTML = `
      <h1>Bulk delete</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Bulk delete</span>
          <div class="setting__control"></div>
          <p class="setting__desc">Pick a time range or search your own posts, then select them and delete in bulk. Each deletion is a NIP-09 request broadcast to relays in the background — relays may honor it or not. Deletion is not guaranteed and cannot be undone.</p>
        </div>
      </section>
      <div data-addon-content="bulk-delete"></div>
    `;

    const controlEl = this.container.querySelector('.setting__control');
    if (controlEl) controlEl.innerHTML = this.enableSwitch.render();
    this.enableSwitch.setupEventListeners(this.container);

    this.contentEl = this.container.querySelector(
      '[data-addon-content="bulk-delete"]'
    );

    if (enabled) this.mountContent();

    this.toggleSubId = TypedEventBus.getInstance().on(
      'bulk-delete:addon-toggle',
      (p: { enabled: boolean }) => {
        if (p.enabled) this.mountContent();
        else this.unmountContent();
      }
    );
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      TypedEventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    if (this.progressRaf) {
      cancelAnimationFrame(this.progressRaf);
      this.progressRaf = 0;
    }
    this.infiniteScroll?.destroy();
    this.infiniteScroll = null;
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.unmountContent();
    this.contentEl = null;
    this.container.innerHTML = '';
  }

  private mountContent(): void {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = `
      <div class="l-row--right bulk-delete__bar">
        <button class="btn" data-action="pick-search">Select by search term</button>
        <button class="btn" data-action="pick-range">Select time range</button>
      </div>
      <div class="l-row--split bulk-delete__range-row">
        <span class="bulk-delete__range" data-range></span>
        <a href="#" data-action="select-all">Select all visible</a>
      </div>
      <div class="ui-list" data-list></div>
      <div class="bulk-delete__footer" data-footer hidden>
        <button class="btn btn--danger" data-action="delete-selected" disabled>Delete selected (0)</button>
        <div class="bulk-delete__progress" data-progress></div>
      </div>
    `;

    this.contentEl
      .querySelector('[data-action="pick-search"]')
      ?.addEventListener('click', () => void this.handlePickSearch());

    this.contentEl
      .querySelector('[data-action="pick-range"]')
      ?.addEventListener('click', () => void this.handlePickRange());

    this.contentEl
      .querySelector('[data-action="delete-selected"]')
      ?.addEventListener('click', () => void this.handleDeleteSelected());

    this.contentEl
      .querySelector('[data-action="select-all"]')
      ?.addEventListener('click', e => {
        e.preventDefault();
        this.toggleSelectAll();
      });

    // The reset link lives inside the (re-rendered) range label; delegate from the
    // persistent span so it survives label re-renders.
    this.contentEl
      .querySelector('[data-range]')
      ?.addEventListener('click', e => {
        if (
          (e.target as HTMLElement).closest('[data-action="reset-filters"]')
        ) {
          e.preventDefault();
          this.resetFilters();
        }
      });

    // Delegated row interactions (survive re-render of the list's children).
    const list = this.contentEl.querySelector(
      '[data-list]'
    ) as HTMLElement | null;
    list?.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-select]')) return; // checkbox handles itself
      const opener = target.closest('[data-open]') as HTMLElement | null;
      const row = target.closest('.bulk-delete__row') as HTMLElement | null;
      const nevent = opener?.dataset.open;
      const id = row?.dataset.id;
      if (!nevent || !id) return;
      // Seed the note cache from the event we already hold, so the Single Note
      // View resolves it instantly instead of re-fetching from relays — old notes
      // often aren't on the read relays anymore ("Note not found").
      const ev = this.notes.find(n => n.id === id);
      if (ev) this.singleNoteApi?.cacheNote(ev);
      getViewNavigationController().openView(
        'single-note',
        nevent,
        e as MouseEvent
      );
    });
    list?.addEventListener('change', e => {
      const cb = e.target as HTMLInputElement;
      if (!cb.matches('[data-select]')) return;
      const id = cb.dataset.id;
      if (!id) return;
      if (cb.checked) this.selected.add(id);
      else this.selected.delete(id);
      this.updateDeleteButton();
      this.saveCache();
    });

    // Restore a recent search (range/search + notes + selection) so re-opening the
    // addon doesn't force a re-search. If there's nothing to restore (fresh enable
    // or new session), load the user's recent posts by default.
    if (!this.restoreFromCache()) {
      void this.loadInitial();
    }

    // Attach to live broadcast progress (and reconnect to one already running).
    this.subscribeProgress();
  }

  /** Persist the current list to sessionStorage so a reload/re-open skips the re-search. */
  private saveCache(): void {
    const pubkey = this.pubkey;
    if (
      !pubkey ||
      (!this.range && this.searchTerms === null && this.notes.length === 0)
    )
      return;
    const slim = (n: NostrEvent): SlimEvent => ({
      id: n.id ?? '',
      pubkey: n.pubkey,
      created_at: n.created_at,
      kind: n.kind ?? 1,
      content: n.content ?? '',
      tags: n.tags ?? [],
    });
    try {
      const searching = this.searchTerms !== null;
      const cache: BulkDeleteCache = {
        version: CACHE_VERSION,
        pubkey,
        range: this.range,
        searchTerms: this.searchTerms,
        searchBase: searching ? this.searchBase.map(slim) : [],
        notes: searching ? [] : this.notes.map(slim), // search mode re-derives notes from searchBase
        selected: [...this.selected],
        hasMore: this.hasMore,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(cache));
    } catch {
      /* quota / serialization — non-fatal, list just won't persist */
    }
  }

  /** Restore a recent, same-account list from sessionStorage. Returns true if restored. */
  private restoreFromCache(): boolean {
    const pubkey = this.pubkey;
    if (!pubkey) return false;
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      const c = JSON.parse(raw) as BulkDeleteCache;
      if (c.version !== CACHE_VERSION) {
        sessionStorage.removeItem(SESSION_KEY); // purge a cache from an older, possibly broken version
        return false;
      }
      if (c.pubkey !== pubkey || Date.now() - c.savedAt > CACHE_TTL_MS)
        return false;
      this.range = c.range;
      this.searchTerms = c.searchTerms ?? null;
      this.selected = new Set(c.selected);

      // Slim events are valid for preview / open / cache-seed (sig isn't needed to display).
      // Defensive re-sort newest-first so a once-mis-ordered cache can't resurface.
      const sortDesc = (evs: SlimEvent[]) =>
        (evs as unknown as NostrEvent[])
          .slice()
          .sort((a, b) => b.created_at - a.created_at);

      if (this.searchTerms !== null) {
        this.searchBase = sortDesc(c.searchBase ?? []);
        this.notes = this.filteredSearchNotes();
        this.hasMore = false;
        this.renderRangeLabel();
        this.renderList();
        return true; // search mode has no infinite scroll
      }

      this.notes = sortDesc(c.notes);
      this.hasMore = c.hasMore;
      this.renderRangeLabel();
      this.renderList();
      this.setupInfiniteScroll();
      return true;
    } catch {
      return false;
    }
  }

  private unmountContent(): void {
    this.progressUnsub?.();
    this.progressUnsub = null;
    this.infiniteScroll?.destroy();
    this.infiniteScroll = null;
    if (this.contentEl) this.contentEl.innerHTML = '';
    this.range = null;
    this.searchTerms = null;
    this.searchBase = [];
    this.notes = [];
    this.selected.clear();
    this.loading = false;
    this.hasMore = false;
  }

  private get pubkey(): string | null {
    return AuthService.getInstance().getCurrentUser()?.pubkey ?? null;
  }

  private get timelineApi(): TimelineModuleApi | null {
    return ModuleLoader.getInstance().getApi<TimelineModuleApi>('timeline');
  }

  private get singleNoteApi(): SingleNoteModuleApi | null {
    return ModuleLoader.getInstance().getApi<SingleNoteModuleApi>(
      'single-note'
    );
  }

  /** The effective [since, until]. Default "recent" view = everything up to now. */
  private effectiveRange(): { since: number; until: number } {
    return this.range ?? { since: 0, until: Math.floor(Date.now() / 1000) };
  }

  /**
   * Feed config for the user's own posts. Always the windowed time-range path
   * (FeedOrchestrator honors since/until via a clean `until`-cursor) — NOT the
   * profile 'until'/'direct' combo, whose shared, stateful pager mis-orders newly
   * arrived posts and stalls loadMore. The default "recent" view is just the range
   * [0, now]; a picked range narrows it.
   */
  private buildFeedConfig(pubkey: string): TimelineConfig {
    const r = this.effectiveRange();
    return {
      source: { kind: 'authors', pubkeys: [pubkey] },
      relays: { kind: 'auto' },
      range: { kind: 'between', since: r.since, until: r.until },
      includeReplies: true,
      fetchMode: 'direct',
      pagination: 'window',
      pageSize: 50,
      polling: false,
      trimDom: false,
      marketplaceInjection: false,
      applyWordFilter: false,
      muteExemptPubkey: pubkey,
    };
  }

  private async handlePickRange(): Promise<void> {
    const result = await pickDateRange({
      title: 'Select Time Range',
      confirmLabel: 'Show Notes',
    });
    if (!result) return;
    this.range = result;
    this.selected.clear();
    // Search active: narrow the already-loaded results client-side, no re-fetch.
    if (this.searchTerms !== null) {
      this.applySearchView();
      this.saveCache();
      return;
    }
    this.notes = [];
    this.updateDeleteButton();
    await this.loadInitial();
  }

  /** Open the search prompt, then run the search (or clear it when left empty). */
  private async handlePickSearch(): Promise<void> {
    const terms = await this.promptSearchTerms(this.searchTerms ?? '');
    if (terms === null) return; // cancelled
    const trimmed = terms.trim();
    if (!trimmed) {
      this.clearSearch();
      return;
    } // empty = leave search mode
    await this.runSearch(trimmed);
  }

  /**
   * Search the user's whole history (kind 1) by reusing the profile module's note
   * search, then keep the full result as the base set. A picked time range narrows
   * it client-side. Only kind-1 text notes are searchable — reposts/articles have
   * no searchable body and are out of scope for the search view.
   */
  private async runSearch(terms: string): Promise<void> {
    const pubkey = this.pubkey;
    const profileApi =
      ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile');
    if (!pubkey || !profileApi) {
      ToastService.show('Search is not available right now', 'error');
      return;
    }

    const seq = ++this.loadSeq;
    this.searchTerms = terms;
    this.selected.clear();
    this.infiniteScroll?.destroy();
    this.infiniteScroll = null;
    this.hasMore = false;
    this.loading = true;
    // Clear the list now so the loading state shows instead of the stale posts —
    // the whole-history search takes a few seconds and would otherwise look frozen.
    this.notes = [];
    this.searchBase = [];
    this.renderRangeLabel();
    this.renderList(); // shows the "Searching your posts…" placeholder

    try {
      const result = await profileApi.searchUserNotes({
        pubkeyHex: pubkey,
        searchTerms: terms,
      });
      if (seq !== this.loadSeq) return; // a newer load/search superseded this one
      this.searchBase = result.events;
    } catch (err) {
      if (seq !== this.loadSeq) return;
      SystemLogger.getInstance().warn(
        'BulkDeleteView',
        `Search failed: ${String(err)}`
      );
      ToastService.show('Search failed', 'error');
      this.searchBase = [];
    }

    this.loading = false;
    this.applySearchView();
    this.saveCache();
  }

  /** Leave search mode and fall back to the date/recent feed (keeping any picked range). */
  private clearSearch(): void {
    if (this.searchTerms === null) return;
    this.searchTerms = null;
    this.searchBase = [];
    this.selected.clear();
    this.notes = [];
    void this.loadInitial();
  }

  /** Drop every filter (search + time range) and return to the default recent view. */
  private resetFilters(): void {
    this.searchTerms = null;
    this.searchBase = [];
    this.range = null;
    this.selected.clear();
    this.notes = [];
    void this.loadInitial();
  }

  /** The search results narrowed by the active time range (if any). */
  private filteredSearchNotes(): NostrEvent[] {
    if (!this.range) return this.searchBase;
    const { since, until } = this.range;
    return this.searchBase.filter(
      n => n.created_at >= since && n.created_at <= until
    );
  }

  /** Re-derive the visible list from the search base + range, then render. */
  private applySearchView(): void {
    this.notes = this.filteredSearchNotes();
    this.renderRangeLabel();
    this.renderList();
  }

  private async loadInitial(): Promise<void> {
    const pubkey = this.pubkey;
    const api = this.timelineApi;
    if (!pubkey || !api) {
      this.renderList();
      return;
    }
    const seq = ++this.loadSeq;
    this.loading = true;
    this.renderRangeLabel();
    this.renderList();

    // Relays are often still cold right after a page load, so the default "recent"
    // fetch can come back empty on the first try. Retry a few times before giving up.
    const r = this.effectiveRange();
    const attempts = this.range ? 1 : 4;
    for (let i = 0; i < attempts; i++) {
      try {
        const result = await api.loadInitialFeed({
          followingPubkeys: [pubkey],
          includeReplies: true,
          exemptFromMuteFilter: pubkey,
          since: r.since,
          until: r.until,
          config: this.buildFeedConfig(pubkey),
        });
        if (seq !== this.loadSeq) return; // superseded by a newer load/search — don't clobber
        this.notes = result.events;
        // We drive paging ourselves (see handleLoadMore).
        this.hasMore = result.events.length > 0;
        if (this.notes.length > 0 || this.range || i === attempts - 1) break;
      } catch (err) {
        if (seq !== this.loadSeq) return;
        SystemLogger.getInstance().warn(
          'BulkDeleteView',
          `Failed to load notes: ${String(err)}`
        );
        ToastService.show('Failed to load your notes', 'error');
        this.notes = [];
        this.hasMore = false;
        break;
      }
      await new Promise(r => setTimeout(r, 1200));
      if (seq !== this.loadSeq) return; // a search started during the retry backoff
    }

    this.loading = false;
    this.renderList();
    this.setupInfiniteScroll();
    this.saveCache();
  }

  private async handleLoadMore(): Promise<void> {
    if (this.loading || !this.hasMore) return;
    const pubkey = this.pubkey;
    const api = this.timelineApi;
    const oldest = this.notes[this.notes.length - 1];
    if (!pubkey || !api || !oldest) return;

    this.loading = true;
    this.infiniteScroll?.showLoading();
    try {
      // A huge timeWindowHours collapses the orchestrator's windowed step onto the
      // full [since, until] range → a clean `until`-cursor page over the whole range
      // (recent view = [0, now]) instead of 3h windows / the stateful profile pager.
      const r = this.effectiveRange();
      const result = await api.loadMore({
        followingPubkeys: [pubkey],
        includeReplies: true,
        since: r.since,
        until: oldest.created_at,
        timeWindowHours: Math.ceil((r.until - r.since) / 3600) + 1,
        exemptFromMuteFilter: pubkey,
        config: this.buildFeedConfig(pubkey),
      });
      // Drop duplicates (paging overlap) before appending.
      const known = new Set(
        this.notes.map(n => n.id).filter((x): x is string => !!x)
      );
      const fresh = result.events.filter(n => n.id && !known.has(n.id));
      this.notes.push(...fresh);
      // Drive paging ourselves: stop when a page yields nothing new (range exhausted).
      this.hasMore = fresh.length > 0;
      this.appendRows(fresh);
    } catch (err) {
      SystemLogger.getInstance().warn(
        'BulkDeleteView',
        `Load more failed: ${String(err)}`
      );
      this.hasMore = false;
    } finally {
      this.loading = false;
      this.infiniteScroll?.hideLoading();
      if (!this.hasMore) this.infiniteScroll?.pause();
      this.saveCache();
    }
  }

  private setupInfiniteScroll(): void {
    const list = this.contentEl?.querySelector(
      '[data-list]'
    ) as HTMLElement | null;
    if (!list) return;
    this.infiniteScroll?.destroy();
    // Search mode loads the whole result set up front — nothing to page.
    if (this.searchTerms !== null || this.notes.length === 0) {
      this.infiniteScroll = null;
      return;
    }
    this.infiniteScroll = new InfiniteScroll(() => void this.handleLoadMore(), {
      loadingMessage: 'Loading more notes...',
    });
    this.infiniteScroll.observe(list);
    if (!this.hasMore) this.infiniteScroll.pause();
  }

  private renderRangeLabel(): void {
    const el = this.contentEl?.querySelector(
      '[data-range]'
    ) as HTMLElement | null;
    if (!el) return;
    const fmt = (s: number) => new Date(s * 1000).toLocaleDateString();

    // No filter active → default view, nothing to reset.
    if (this.searchTerms === null && !this.range) {
      el.textContent = 'Your recent posts';
      return;
    }

    // Active filter (search and/or range): show it, plus one reset back to default.
    let label: string;
    if (this.searchTerms !== null) {
      const rangePart = this.range
        ? ` · ${fmt(this.range.since)} to ${fmt(this.range.until)}`
        : '';
      label = `Search “${this.searchTerms}”${rangePart}`;
    } else {
      label = `Your posts from ${fmt(this.range!.since)} to ${fmt(this.range!.until)}`;
    }
    el.innerHTML =
      `${escapeHtml(label)} ` +
      `<a href="#" data-action="reset-filters" class="bulk-delete__reset" title="Reset filters">Reset</a>`;
  }

  private renderList(): void {
    const list = this.contentEl?.querySelector(
      '[data-list]'
    ) as HTMLElement | null;
    const footer = this.contentEl?.querySelector(
      '[data-footer]'
    ) as HTMLElement | null;
    if (!list) return;

    if (this.loading && this.notes.length === 0) {
      const msg =
        this.searchTerms !== null
          ? 'Searching your posts…'
          : 'Loading your notes...';
      list.innerHTML = `<div class="bulk-delete__empty pulsate">${msg}</div>`;
      if (footer) footer.hidden = true;
      return;
    }
    if (this.notes.length === 0) {
      const msg =
        this.searchTerms !== null
          ? 'No posts match your search.'
          : this.range
            ? 'No posts found in this range.'
            : 'No posts found.';
      list.innerHTML = `<div class="bulk-delete__empty">${msg}</div>`;
      if (footer) footer.hidden = true;
      return;
    }

    list.innerHTML = this.notes.map(n => this.renderRow(n)).join('');
    if (footer) footer.hidden = false;
    this.updateDeleteButton();
  }

  private appendRows(events: NostrEvent[]): void {
    const list = this.contentEl?.querySelector(
      '[data-list]'
    ) as HTMLElement | null;
    if (!list || events.length === 0) return;
    list.insertAdjacentHTML(
      'beforeend',
      events.map(n => this.renderRow(n)).join('')
    );
    this.infiniteScroll?.refresh(); // keep sentinel after the new rows
    this.updateSelectAllLabel(); // new unselected rows → may flip "Unselect all" back
  }

  private renderRow(ev: NostrEvent): string {
    const id = ev.id;
    if (!id) return '';
    // Bare nevent (no "nostr:" prefix) — SingleNoteView.decodeNoteId expects
    // "nevent1…"; with the prefix it can't decode and reports "Note not found".
    const nevent = encodeNevent(id, [], ev.pubkey || '').replace(/^nostr:/, '');
    const date = new Date(ev.created_at * 1000).toLocaleDateString();
    const checked = this.selected.has(id) ? ' checked' : '';
    return `
      <div class="ui-list__item bulk-delete__row" data-id="${escapeHtml(id)}">
        <span class="bulk-delete__text" data-open="${escapeHtml(nevent)}">${escapeHtml(this.preview(ev))}</span>
        <span class="bulk-delete__date">${escapeHtml(date)}</span>
        <span class="nn-checkbox bulk-delete__select">
          <input type="checkbox" data-select data-id="${escapeHtml(id)}" aria-label="Select for deletion"${checked} />
        </span>
      </div>
    `;
  }

  /** One-line, text-flattened preview. Media-only posts show (Image)/(Video). */
  private preview(ev: NostrEvent): string {
    // Reposts embed the original event's JSON as content — never show that raw.
    if (ev.kind === 6 || ev.kind === 16) return '(Repost)';

    const content = ev.content || '';
    const media = extractMedia(content);
    // Strip media URLs to see if any real text remains.
    let stripped = content;
    for (const m of media) {
      if (m.url) stripped = stripped.split(m.url).join(' ');
      if (m.originalUrl) stripped = stripped.split(m.originalUrl).join(' ');
    }
    stripped = stripped.replace(/\s+/g, ' ').trim();

    if (stripped) return truncateNoteContent(stripped, PREVIEW_LEN);

    if (media.length > 0) {
      const t = media[0]!.type;
      return t === 'video' ? '(Video)' : t === 'audio' ? '(Audio)' : '(Image)';
    }
    // No text, no media — label by kind so the row is never blank.
    if (ev.kind === 30023) return '(Article)';
    return '(no text)';
  }

  private get allSelected(): boolean {
    return (
      this.notes.length > 0 &&
      this.notes.every(n => !!n.id && this.selected.has(n.id))
    );
  }

  /** Toggle between selecting all currently-loaded notes and clearing the selection. */
  private toggleSelectAll(): void {
    const checked = !this.allSelected;
    this.selected = checked
      ? new Set(this.notes.map(n => n.id).filter((x): x is string => !!x))
      : new Set();
    this.contentEl?.querySelectorAll('input[data-select]').forEach(cb => {
      (cb as HTMLInputElement).checked = checked;
    });
    this.updateDeleteButton();
    this.updateSelectAllLabel();
    this.saveCache();
  }

  /** "Select all" when not everything is selected, "Unselect all" when it is. */
  private updateSelectAllLabel(): void {
    const link = this.contentEl?.querySelector('[data-action="select-all"]');
    if (link)
      link.textContent = this.allSelected
        ? 'Unselect all visible'
        : 'Select all visible';
  }

  /**
   * Modal text prompt for search terms (mirrors the date-range modal). Resolves
   * with the entered string, or `null` if cancelled.
   */
  private promptSearchTerms(initial: string): Promise<string | null> {
    const modalService = ModalService.getInstance();
    return new Promise(resolve => {
      let resolved = false;
      const container = document.createElement('div');
      container.className = 'date-range-selector';
      container.innerHTML = `
        <div class="form__row">
          <input type="text" class="input" data-search-input placeholder="Search terms..." value="${escapeHtml(initial)}" />
        </div>
        <div class="date-range-selector__actions">
          <button class="btn btn--secondary" data-search-cancel>Cancel</button>
          <button class="btn" data-search-confirm>Search</button>
        </div>
      `;

      modalService.show({
        title: 'Search your posts',
        content: container,
        width: '380px',
        height: 'auto',
        showCloseButton: true,
        closeOnOverlay: true,
        closeOnEsc: true,
        onClose: () => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        },
      });

      setTimeout(() => {
        const input = container.querySelector(
          '[data-search-input]'
        ) as HTMLInputElement;
        const done = (val: string | null): void => {
          if (resolved) return;
          resolved = true;
          modalService.hide();
          resolve(val);
        };
        container
          .querySelector('[data-search-cancel]')
          ?.addEventListener('click', () => done(null));
        container
          .querySelector('[data-search-confirm]')
          ?.addEventListener('click', () => done(input?.value ?? ''));
        input?.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done(input.value);
          }
        });
        input?.focus();
      }, 0);
    });
  }

  private updateDeleteButton(): void {
    const btn = this.contentEl?.querySelector(
      '[data-action="delete-selected"]'
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const n = this.selected.size;
    btn.textContent = `Delete selected (${n})`;
    btn.disabled = n === 0 || this.dispatching;
    this.updateSelectAllLabel();
  }

  private async handleDeleteSelected(): Promise<void> {
    const ids = [...this.selected];
    if (ids.length === 0 || this.dispatching) return;
    const postsApi = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
    if (!postsApi) {
      ToastService.show('Posts module not ready', 'error');
      return;
    }

    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete selected posts',
      message: `Send a deletion request for ${ids.length} post${ids.length === 1 ? '' : 's'}? This broadcasts a NIP-09 request to relays and cannot be undone. Relays may or may not honor it.`,
      confirmText: 'Delete',
      cancelText: 'Keep',
      confirmDestructive: true,
    });
    if (!confirmed) return;

    // Chunk into <=100 e-tags per kind:5 to keep events relay-friendly.
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE)
      chunks.push(ids.slice(i, i + CHUNK_SIZE));

    this.dispatching = true;
    this.justCompleted = false;
    this.deleteNoteCount = ids.length;
    this.summary = null;
    this.lastHost = null;
    this.renderProgress();
    this.updateDeleteButton();
    this.scrollToProgress(); // make sure the user sees that a broadcast just started

    // Progress flows via the BroadcastDeleteService subscription wired in mountContent.
    for (const chunk of chunks) {
      try {
        await postsApi.deleteEvents({ eventIds: chunk, silent: true });
      } catch (err) {
        SystemLogger.getInstance().warn(
          'BulkDeleteView',
          `Delete chunk failed: ${String(err)}`
        );
      }
    }

    this.dispatching = false;
    void this.pollSummary();

    // Optimistically remove the deleted notes from the list (and the search base,
    // so a later range change can't resurface them).
    const deleted = new Set(ids);
    this.notes = this.notes.filter(n => !(n.id && deleted.has(n.id)));
    this.searchBase = this.searchBase.filter(n => !(n.id && deleted.has(n.id)));
    this.selected.clear();
    this.renderList();
    if (this.searchTerms === null) this.setupInfiniteScroll();
    this.saveCache();
  }

  /** Subscribe to live broadcast progress, and reconnect if one is still running. */
  private subscribeProgress(): void {
    const postsApi = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
    if (!postsApi) return;
    this.progressUnsub?.();
    this.progressUnsub = postsApi.subscribeDeleteProgress(p =>
      this.onBroadcastProgress(p)
    );
    void this.pollSummary(); // reconnect to a broadcast still running from a prior view
  }

  private onBroadcastProgress(p: BroadcastProgress): void {
    if (!p.done && p.host) this.lastHost = { host: p.host, ok: p.ok };
    this.schedulePoll();
    this.scheduleProgressRender();
  }

  /** Refresh the aggregate delivery state (throttled — there are many relay events/sec). */
  private schedulePoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = 0;
      void this.pollSummary();
    }, 600);
  }

  private async pollSummary(): Promise<void> {
    const postsApi = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
    const next = await (postsApi?.getDeleteProgressSummary() ??
      Promise.resolve(null));
    if (this.summary !== null && next === null) this.justCompleted = true;
    this.summary = next;
    this.scheduleProgressRender();
  }

  private scheduleProgressRender(): void {
    if (this.progressRaf) return;
    this.progressRaf = requestAnimationFrame(() => {
      this.progressRaf = 0;
      this.renderProgress();
    });
  }

  /** Scroll the progress anchor into view so a running broadcast isn't missed. */
  private scrollToProgress(): void {
    const el = this.contentEl?.querySelector(
      '[data-progress]'
    ) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  private renderProgress(): void {
    const el = this.contentEl?.querySelector(
      '[data-progress]'
    ) as HTMLElement | null;
    if (!el) return;
    const s = this.summary;

    // First pass running: relays still being contacted for the first time.
    const firstPassRunning =
      (!!s && s.contacted < s.total) || (this.dispatching && !s);
    if (firstPassRunning) {
      const head =
        this.deleteNoteCount > 0
          ? `<p class="bulk-delete__progress-head pulsate">Deleting ${this.deleteNoteCount} post${this.deleteNoteCount === 1 ? '' : 's'}…</p>`
          : `<p class="bulk-delete__progress-head pulsate">Broadcasting deletion in the background…</p>`;
      let relayLine = '';
      if (this.lastHost && s) {
        const dotClass = this.lastHost.ok
          ? 'bulk-delete__dot--success'
          : 'bulk-delete__dot--error';
        relayLine = `<p class="bulk-delete__progress-relay">Sending request to ${escapeHtml(this.lastHost.host)} (${s.contacted}/${s.total})<span class="bulk-delete__dot ${dotClass}"></span></p>`;
      }
      el.innerHTML = head + relayLine;
      return;
    }

    // First pass done for a delete this view started → closure (dead relays still retry silently).
    if (s && this.deleteNoteCount > 0) {
      el.innerHTML = `<p class="bulk-delete__progress-head">Deletion broadcast sent.</p>`;
      return;
    }

    el.innerHTML = this.justCompleted
      ? `<p class="bulk-delete__progress-head">Deletion broadcast complete.</p>`
      : '';
  }
}
