/**
 * TimelineView
 * PCC-View for displaying timeline with tribe tabs
 *
 * Features:
 * - Tab-based navigation: "Timeline" (all follows) + tribe tabs
 * - Horizontal scrollable tabs for many tribes
 * - "Edit" link to open TribeSecondaryManager
 *
 * @purpose Main timeline view with integrated tribe filtering
 * @used-by Router (/ route)
 */

import { View } from './View';
import { _ } from '../../i18n';
import { Timeline } from '../timeline/Timeline';
import { LastNotesPerFollow } from '../timeline/LastNotesPerFollow';
import {
  followingTimelineConfig,
  tribeTimelineConfig,
} from '../timeline/TimelineConfig';
import { TypedEventBus } from '../../core/TypedEventBus';
import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../services/SystemLogger';
import { isTribesEnabled } from '../../addons/tribes/index';
import { delegateToFocusUi } from '../../helpers/focusUiNavigation';

type TabType = 'timeline' | 'last-notes' | 'tribe';

interface TabInfo {
  type: TabType;
  id: string; // 'timeline', 'last-notes', or tribe folder ID
  name: string; // Display name
}

export class TimelineView extends View {
  private container: HTMLElement;
  private timeline: Timeline | LastNotesPerFollow | null = null;
  private eventBus: TypedEventBus;
  private authService: AuthService;
  private currentTabId: string = 'timeline';
  private tabs: TabInfo[] = [];
  private userPubkey: string = '';
  private userLoginSubscriptionId: string | null = null;
  private isRendering: boolean = false;
  private pendingRerender: boolean = false;
  // Tab-row rebuild serialization: several tribe:updated events can fire
  // in quick succession (e.g. folder create emits twice). Interleaved
  // async rebuilds would corrupt this.tabs (core tabs pushed sync, tribe
  // tabs after the dynamic import — the resets overwrite each other and
  // the tribe pushes pile up). One rebuild at a time; late events coalesce
  // into exactly one more run.
  private tabRowRefreshing = false;
  private tabRowRefreshPending = false;

  constructor() {
    super();
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--timeline';
    this.setupUserLoginListener();
    void this.render();
  }

  /**
   * Setup listener for user account switches
   * When user switches accounts, re-render entire view with new user's tribes
   */
  private setupUserLoginListener(): void {
    this.userLoginSubscriptionId = this.eventBus.on(
      'user:login',
      (data: { pubkey: string }) => {
        // Only re-render if pubkey actually changed
        if (data.pubkey !== this.userPubkey) {
          this.userPubkey = data.pubkey;
          this.currentTabId = 'timeline'; // Reset to Timeline tab
          this.rerender();
        }
      }
    );

    // Re-render when Tribes addon is toggled (adds/removes tribe tabs)
    this.eventBus.on('tribes:addon-toggle', () => {
      this.currentTabId = 'timeline';
      this.rerender();
    });

    // Rebuild the tab row when a tribe changes (created/renamed/reordered/
    // deleted — also from the v2 Tribes surface). In-place: the active tab
    // and the timeline stay untouched.
    this.eventBus.on('tribe:updated', () => {
      void this.refreshTabRow();
    });
  }

  /**
   * Re-render entire view (for account switch)
   */
  private rerender(): void {
    const logger = SystemLogger.getInstance();

    // If currently rendering, mark pending and return
    if (this.isRendering) {
      logger.info('TimelineView', 'rerender() deferred - render in progress');
      this.pendingRerender = true;
      return;
    }

    logger.info('TimelineView', 'rerender() called');

    // Destroy existing timeline
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }

    // Clear container and re-render
    this.container.innerHTML = '';
    void this.render();
  }

  /**
   * Render the view
   */
  private async render(): Promise<void> {
    const logger = SystemLogger.getInstance();

    // Prevent parallel render calls
    this.isRendering = true;
    this.pendingRerender = false;

    // Wait for auth service to initialize (handles session restore)
    await this.authService.waitForInitialization();

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.container.innerHTML = `<div class="timeline-view__error">${_('Please login to view timeline')}</div>`;
      this.isRendering = false;
      return;
    }

    this.userPubkey = currentUser.pubkey;

    // Page heading ("Social Media"): visible in v2 as the domain heading,
    // screen-reader-only in v1 — the hiding is scoped per interface in
    // SCSS (see .timeline-view__title in _timeline-view.scss), not via
    // the .visually-hidden class (that would hide it in v2 as well).
    // In v2 the heading row carries the Write Note button (right side);
    // v1 keeps the +New Post dropup, so the button is CSS-hidden there.
    const titleRow = document.createElement('div');
    titleRow.className = 'l-row--split timeline-view__title-row';

    const pageHeading = document.createElement('h1');
    pageHeading.className = 'timeline-view__title';
    pageHeading.textContent = _('Social Media');
    titleRow.appendChild(pageHeading);

    const writeNoteBtn = document.createElement('button');
    writeNoteBtn.className = 'btn timeline-view__write-btn';
    writeNoteBtn.textContent = _('Write Note');
    writeNoteBtn.addEventListener('click', () => {
      // Focus UI: the composer opens as the social surface's flat detail
      // (/timeline/new-note). Classic: nothing (button is hidden in v1).
      delegateToFocusUi('new-note');
    });
    titleRow.appendChild(writeNoteBtn);

    this.container.appendChild(titleRow);

    // Build tabs: Timeline first, then tribes (async for addon lazy-loading)
    await this.buildTabs();

    // The tab bar always carries at least Timeline + Last notes per follow.
    if (this.tabs.length > 1) {
      this.container.appendChild(this.buildHeader());
    }

    // Timeline container
    const timelineContainer = document.createElement('div');
    timelineContainer.className = 'timeline-view__timeline';
    this.container.appendChild(timelineContainer);

    // Create initial timeline (all follows)
    await this.updateTimeline();

    // Done rendering
    this.isRendering = false;

    // If rerender was requested during render, do it now
    if (this.pendingRerender) {
      logger.info('TimelineView', 'Processing deferred rerender');
      this.pendingRerender = false;
      this.rerender();
    }
  }

  /**
   * Build the tab-row header: the scrollable tabs plus the "Edit tribes"
   * link (the link morphs to the Tribes object in the Focus UI via the
   * navigation seam; the classic UI keeps the list tab).
   */
  private buildHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'timeline-view__header';

    // Tabs container (horizontal scrollable)
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'timeline-view__tabs-container';

    // Tabs wrapper for horizontal scroll
    const tabsWrapper = document.createElement('div');
    tabsWrapper.className = 'tabs tabs--scrollable';

    // Create all tabs
    this.tabs.forEach(tab => {
      const isActive = tab.id === this.currentTabId;
      const tabEl = this.createTab(tab, isActive);
      tabsWrapper.appendChild(tabEl);
    });

    tabsContainer.appendChild(tabsWrapper);

    // Edit link — only meaningful when the Tribes addon is on.
    if (isTribesEnabled()) {
      const editLink = document.createElement('button');
      editLink.className =
        'timeline-view__edit-link btn btn--mini btn--passive';
      editLink.textContent = _('Edit tribes');
      editLink.addEventListener('click', () => {
        // Focus UI: the Tribes object owns the 'tribes' view type — the
        // stage switches to it (same as clicking the circle). Classic:
        // the list tab as before.
        if (!delegateToFocusUi('tribes')) {
          this.eventBus.emit('list:open', { listType: 'tribes' });
        }
      });
      tabsContainer.appendChild(editLink);
    }

    header.appendChild(tabsContainer);
    return header;
  }

  /**
   * Rebuild the tab row in place after tribe edits (`tribe:updated`):
   * tabs re-derive from the tribes list while the active tab survives
   * renames — only a deleted current tribe falls back to the main
   * timeline. No full rerender: the timeline and its scroll position
   * stay untouched. The v2 Tribes surface edits run through this too.
   */
  private async refreshTabRow(): Promise<void> {
    // Serialize: late events coalesce into one more run instead of
    // interleaving with a running rebuild.
    if (this.tabRowRefreshing) {
      this.tabRowRefreshPending = true;
      return;
    }
    this.tabRowRefreshing = true;
    try {
      await this.buildTabs();
      if (!this.tabs.some(tab => tab.id === this.currentTabId)) {
        this.currentTabId = 'timeline';
        await this.updateTimeline();
      }
      const timelineContainer = this.container.querySelector(
        '.timeline-view__timeline'
      );
      this.container.querySelector('.timeline-view__header')?.remove();
      if (this.tabs.length > 1 && timelineContainer) {
        this.container.insertBefore(this.buildHeader(), timelineContainer);
      }
    } finally {
      this.tabRowRefreshing = false;
      if (this.tabRowRefreshPending) {
        this.tabRowRefreshPending = false;
        await this.refreshTabRow();
      }
    }
  }

  /**
   * Build tabs array: Timeline + all tribes
   */
  private async buildTabs(): Promise<void> {
    this.tabs = [];

    // First tab: Timeline (all follows)
    this.tabs.push({
      type: 'timeline',
      id: 'timeline',
      name: _('Timeline'),
    });

    // Fixed second tab: newest note from each followed user, freshest author first.
    // Core, always present (derived from the follow list) — sits before the tribes.
    this.tabs.push({
      type: 'last-notes',
      id: 'last-notes',
      name: _('Last notes per follow'),
    });

    // Add tribe tabs (only if addon enabled)
    if (isTribesEnabled()) {
      const tribes = await import('../../lists/tribes');
      const tribeFolders = tribes.getFoldersInRootOrder();

      tribeFolders.forEach(folder => {
        this.tabs.push({
          type: 'tribe',
          id: folder.id,
          name: folder.name,
        });
      });
    }
  }

  /**
   * Create a tab button
   */
  private createTab(tab: TabInfo, isActive: boolean): HTMLElement {
    const tabEl = document.createElement('button');
    tabEl.className = isActive ? 'tab tab--active' : 'tab';
    tabEl.dataset.tabId = tab.id;
    tabEl.dataset.tabType = tab.type;
    tabEl.textContent = tab.name;

    tabEl.addEventListener('click', async () => {
      // Update active state
      const allTabs = this.container.querySelectorAll('.tab');
      allTabs.forEach(t => t.classList.remove('tab--active'));
      tabEl.classList.add('tab--active');

      // Update current tab
      this.currentTabId = tab.id;

      // Reload timeline
      await this.updateTimeline();
    });

    return tabEl;
  }

  /**
   * Update timeline based on selected tab
   */
  private async updateTimeline(): Promise<void> {
    // Destroy existing timeline
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }

    if (this.currentTabId === 'last-notes') {
      // Dedicated view: newest note per followed user (does not touch the main feed).
      this.timeline = new LastNotesPerFollow(this.userPubkey);
    } else {
      // Tribe tab (explicit members) or the main following feed.
      let filterPubkeys: string[] | undefined;
      if (this.currentTabId !== 'timeline' && isTribesEnabled()) {
        const tribes = await import('../../lists/tribes');
        filterPubkeys = tribes.getMemberPubkeysInFolder(this.currentTabId);
      }
      this.timeline = new Timeline(
        this.userPubkey,
        filterPubkeys
          ? tribeTimelineConfig(filterPubkeys)
          : followingTimelineConfig()
      );
    }

    // Mount timeline
    const timelineContainer = this.container.querySelector(
      '.timeline-view__timeline'
    );
    if (timelineContainer) {
      timelineContainer.innerHTML = '';
      timelineContainer.appendChild(this.timeline.getElement());
    }
  }

  /**
   * Get element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Destroy view
   */
  public destroy(): void {
    // Unsubscribe from user login events
    if (this.userLoginSubscriptionId) {
      this.eventBus.off(this.userLoginSubscriptionId);
      this.userLoginSubscriptionId = null;
    }

    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }
    this.container.innerHTML = '';
  }

  /**
   * Pause timeline when navigating away
   */
  public override pause(): void {
    if (this.timeline) {
      this.timeline.pause();
    }
  }

  /**
   * Resume timeline when navigating back
   */
  public override resume(): void {
    if (this.timeline) {
      this.timeline.resume();
    }
  }

  /**
   * Save view state (scroll position)
   */
  public override saveState(): void {
    if (this.timeline) {
      this.timeline.saveState();
    }
  }

  /**
   * Restore view state (scroll position)
   */
  public override restoreState(): void {
    if (this.timeline) {
      this.timeline.restoreState();
    }
  }
}
