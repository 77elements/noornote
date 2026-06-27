/**
 * LastNotesPerFollow
 *
 * A standalone timeline-like view that shows the single newest note of EACH
 * followed user, the freshest author first. Lets you catch people who only post
 * weekly/monthly — they surface here instead of drowning under the daily posters
 * in the main feed (inspired by Notedeck's "Contacts (last notes)").
 *
 * Read-only: derived from the follow list, no polling, no storage, no list sync.
 * It deliberately does NOT touch the main Timeline component — it reuses the
 * decoupled building blocks (state manager, renderer, ISL stats, infinite scroll)
 * so the sensitive feed machinery stays untouched.
 *
 * Data: FeedOrchestrator.loadLatestPerAuthor() fetches one-note-per-author across
 * all follows up front (batched per-author limit:1 filters) and returns the full
 * sorted list. The view then paginates the DISPLAY — first 20, then +20 on scroll.
 */

import { View } from '../views/View';
import { FeedOrchestrator } from '../../services/orchestration/FeedOrchestrator';
import { UserService } from '../../services/UserService';
import { AuthService } from '../../services/AuthService';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { CustomDropdown } from '../ui/CustomDropdown';
import { getSavedFeedMode, saveFeedMode, type FeedMode } from './TimelineConfig';
import { TimelineStateManager } from './timeline-state/TimelineStateManager';
import { TimelineUIStateHandler } from './timeline-ui/TimelineUIStateHandler';
import { TimelineRenderer } from './timeline-ui/TimelineRenderer';
import { ISLStatsUpdater } from './timeline-features/ISLStatsUpdater';
import { ScrollPositionManager } from './timeline-features/ScrollPositionManager';
import { NoteUI } from '../ui/NoteUI';
import { SystemLogger } from '../../services/SystemLogger';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

/** How many author-cards to reveal per display page. */
const PAGE_SIZE = 20;

export class LastNotesPerFollow extends View {
  private element: HTMLElement;
  private userPubkey: string;

  private feedOrchestrator: FeedOrchestrator;
  private userService: UserService;
  private authService: AuthService;

  private stateManager: TimelineStateManager;
  private uiStateHandler: TimelineUIStateHandler;
  private renderer: TimelineRenderer;
  private islStatsUpdater: ISLStatsUpdater;
  private scrollPositionManager: ScrollPositionManager;
  private infiniteScroll: InfiniteScroll;
  private viewDropdown: CustomDropdown | null = null;

  /** Full sorted result (one note per author); the display is paginated from this. */
  private allEvents: NostrEvent[] = [];
  /** How many of allEvents are currently rendered. */
  private shownCount = 0;
  private loading = false;

  constructor(userPubkey: string) {
    super();
    this.userPubkey = userPubkey;
    this.feedOrchestrator = FeedOrchestrator.getInstance();
    this.userService = UserService.getInstance();
    this.authService = AuthService.getInstance();

    this.element = this.createElement();

    this.stateManager = new TimelineStateManager();
    this.uiStateHandler = new TimelineUIStateHandler(this.element);
    // Allow DOM trimming (long ranked list) — same as the main timeline.
    this.renderer = new TimelineRenderer(this.element, this.stateManager, this.uiStateHandler, false);
    this.islStatsUpdater = new ISLStatsUpdater(this.element);
    this.scrollPositionManager = new ScrollPositionManager(this.element);

    this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
      loadingMessage: 'Loading more…',
      rootMargin: '0px 0px 1200px 0px',
    });

    this.element.querySelector('[data-action="refresh"]')
      ?.addEventListener('click', () => void this.load());

    this.setupViewDropdown();

    void this.load();
  }

  /**
   * Latest / Latest + Replies selector — the same preference the main timeline
   * uses (shared StorageKeys.TIMELINE_VIEW), so the two stay in sync. Time Range
   * and per-relay options don't apply to a per-author-latest list, so they're omitted.
   */
  private setupViewDropdown(): void {
    this.viewDropdown = new CustomDropdown({
      options: [
        { value: 'latest', label: 'Latest' },
        { value: 'latest-replies', label: 'Latest + Replies' },
      ],
      selectedValue: getSavedFeedMode(),
      onChange: (value: string) => {
        const mode: FeedMode = value === 'latest-replies' ? 'latest-replies' : 'latest';
        saveFeedMode(mode);
        void this.load();
      },
      className: 'timeline-view-dropdown',
    });
    const mount = this.element.querySelector('.timeline-view-selector');
    if (mount) mount.appendChild(this.viewDropdown.getElement());
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'timeline timeline--last-notes';
    container.innerHTML = `
      <div class="timeline-header">
        <div class="timeline-view-selector"></div>
        <div class="timeline-controls">
          <button class="btn btn--refresh" type="button" data-action="refresh">Refresh</button>
        </div>
      </div>

      <div class="timeline-load-trigger" style="height: 20px;"></div>

      <div class="timeline-loading" style="display: none;">
        <div class="loading-spinner"></div>
        <p>Loading more events...</p>
      </div>

      <div class="timeline-empty" style="display: none;">
        <h3>No notes found</h3>
        <p>Follow some users or check your relay connections.</p>
      </div>
    `;
    return container;
  }

  /** Fetch (or re-fetch) the latest note per follow and render the first page. */
  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.setRefreshDisabled(true);

    // Reset list + DOM.
    this.allEvents = [];
    this.shownCount = 0;
    this.stateManager.clear();
    NoteUI.cleanupAll(this.element);
    this.element.querySelectorAll<HTMLElement>('.note-card').forEach(card => card.remove());
    this.infiniteScroll.pause();
    this.uiStateHandler.hideEmptyState();
    this.uiStateHandler.showSkeletonLoaders(5);

    try {
      await this.authService.waitForInitialization();

      const followingPubkeys = await this.userService.getUserFollowing(this.userPubkey);
      if (followingPubkeys.length === 0) {
        this.uiStateHandler.hideSkeletonLoaders();
        this.uiStateHandler.showEmptyState();
        return;
      }

      this.allEvents = await this.feedOrchestrator.loadLatestPerAuthor(
        followingPubkeys,
        getSavedFeedMode() === 'latest-replies', // same Latest / Latest+Replies preference as the main timeline
        true                                     // apply Word Filter addon when enabled (processEvents checks internally)
      );

      this.uiStateHandler.hideSkeletonLoaders();

      if (this.allEvents.length === 0) {
        this.uiStateHandler.showEmptyState();
        return;
      }

      // First display page.
      const firstPage = this.allEvents.slice(0, PAGE_SIZE);
      this.shownCount = firstPage.length;
      this.stateManager.setEvents(firstPage);
      this.renderer.renderEvents();
      this.islStatsUpdater.fetchAndUpdateStats(firstPage);

      this.setupInfiniteScroll();
    } catch (error) {
      SystemLogger.getInstance().warn('LastNotesPerFollow', `Failed to load: ${error}`);
      this.uiStateHandler.hideSkeletonLoaders();
      this.uiStateHandler.showError('Failed to load. Please check your connection.');
    } finally {
      this.loading = false;
      this.setRefreshDisabled(false);
    }
  }

  private setupInfiniteScroll(): void {
    const loadTrigger = this.element.querySelector('.timeline-load-trigger') as HTMLElement | null;
    if (!loadTrigger) return;
    this.infiniteScroll.observe(loadTrigger, loadTrigger.closest('.timeline-view__timeline'));
    if (this.shownCount >= this.allEvents.length) this.infiniteScroll.pause();
  }

  /** Reveal the next display page from the already-fetched, sorted list (no network). */
  private handleLoadMore(): void {
    if (this.shownCount >= this.allEvents.length) {
      this.infiniteScroll.pause();
      return;
    }
    const next = this.allEvents.slice(this.shownCount, this.shownCount + PAGE_SIZE);
    if (next.length === 0) {
      this.infiniteScroll.pause();
      return;
    }
    this.stateManager.addEvents(next);
    this.renderer.appendNewEvents(next);
    this.islStatsUpdater.fetchAndUpdateStats(next);
    this.shownCount += next.length;
    this.infiniteScroll.refresh();
    if (this.shownCount >= this.allEvents.length) this.infiniteScroll.pause();
  }

  private setRefreshDisabled(disabled: boolean): void {
    const btn = this.element.querySelector('[data-action="refresh"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = disabled;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public override saveState(): void {
    this.scrollPositionManager.save();
  }

  public override restoreState(): void {
    this.scrollPositionManager.restore();
  }

  public override pause(): void {
    this.infiniteScroll.pause();
  }

  public override resume(): void {
    if (this.shownCount < this.allEvents.length) this.infiniteScroll.resume();
  }

  public destroy(): void {
    this.viewDropdown?.destroy();
    this.viewDropdown = null;
    this.infiniteScroll.destroy();
    NoteUI.cleanupAll(this.element);
    this.element.remove();
  }
}
