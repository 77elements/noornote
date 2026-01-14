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
import { Timeline } from '../timeline/Timeline';
import { TribeFolderService } from '../../services/TribeFolderService';
import { EventBus } from '../../services/EventBus';
import { AuthService } from '../../services/AuthService';

type TabType = 'timeline' | 'tribe';

interface TabInfo {
  type: TabType;
  id: string;      // 'timeline' or tribe folder ID
  name: string;    // Display name
}

export class TimelineView extends View {
  private container: HTMLElement;
  private timeline: Timeline | null = null;
  private tribeFolderService: TribeFolderService;
  private eventBus: EventBus;
  private authService: AuthService;
  private currentTabId: string = 'timeline';
  private tabs: TabInfo[] = [];
  private userPubkey: string = '';
  private userLoginSubscriptionId: string | null = null;

  constructor() {
    super();
    this.tribeFolderService = TribeFolderService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.container = document.createElement('div');
    this.container.className = 'timeline-view';
    this.setupUserLoginListener();
    this.render();
  }

  /**
   * Setup listener for user account switches
   * When user switches accounts, re-render entire view with new user's tribes
   */
  private setupUserLoginListener(): void {
    this.userLoginSubscriptionId = this.eventBus.on('user:login', (data: { pubkey: string }) => {
      // Only re-render if pubkey actually changed
      if (data.pubkey !== this.userPubkey) {
        this.userPubkey = data.pubkey;
        this.currentTabId = 'timeline'; // Reset to Timeline tab
        this.rerender();
      }
    });
  }

  /**
   * Re-render entire view (for account switch)
   */
  private rerender(): void {
    // Destroy existing timeline
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }

    // Clear container and re-render
    this.container.innerHTML = '';
    this.render();
  }

  /**
   * Render the view
   */
  private async render(): Promise<void> {
    // Wait for auth service to initialize (handles session restore)
    await this.authService.waitForInitialization();

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.container.innerHTML = '<div class="timeline-view__error">Please login to view timeline</div>';
      return;
    }

    this.userPubkey = currentUser.pubkey;

    // Build tabs: Timeline first, then tribes
    this.buildTabs();

    // Check if user has tribes defined
    const hasTribes = this.tabs.length > 1;

    // Only show header with tabs if user has at least one tribe
    if (hasTribes) {
      // Build header with tabs and edit link
      const header = document.createElement('div');
      header.className = 'timeline-view__header';

      // Tabs container (horizontal scrollable)
      const tabsContainer = document.createElement('div');
      tabsContainer.className = 'timeline-view__tabs-container';

      // Tabs wrapper for horizontal scroll
      const tabsWrapper = document.createElement('div');
      tabsWrapper.className = 'tabs tabs--scrollable';

      // Create all tabs
      this.tabs.forEach((tab, index) => {
        const isActive = index === 0;
        const tabEl = this.createTab(tab, isActive);
        tabsWrapper.appendChild(tabEl);
      });

      tabsContainer.appendChild(tabsWrapper);

      // Edit link
      const editLink = document.createElement('button');
      editLink.className = 'timeline-view__edit-link';
      editLink.textContent = 'Edit ›';
      editLink.addEventListener('click', () => {
        this.eventBus.emit('list:open', { listType: 'tribes' });
      });
      tabsContainer.appendChild(editLink);

      header.appendChild(tabsContainer);
      this.container.appendChild(header);
    }

    // Timeline container
    const timelineContainer = document.createElement('div');
    timelineContainer.className = 'timeline-view__timeline';
    this.container.appendChild(timelineContainer);

    // Create initial timeline (all follows)
    await this.updateTimeline();
  }

  /**
   * Build tabs array: Timeline + all tribes
   */
  private buildTabs(): void {
    this.tabs = [];

    // First tab: Timeline (all follows)
    this.tabs.push({
      type: 'timeline',
      id: 'timeline',
      name: 'Timeline'
    });

    // Get tribes in root order
    const tribes = this.tribeFolderService.getFoldersInRootOrder();

    // Add tribe tabs
    tribes.forEach(tribe => {
      this.tabs.push({
        type: 'tribe',
        id: tribe.id,
        name: tribe.name
      });
    });
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
    // Determine filter pubkeys (undefined = all follows, array = specific tribe members)
    const filterPubkeys = this.currentTabId !== 'timeline'
      ? this.tribeFolderService.getMemberPubkeysInFolder(this.currentTabId)
      : undefined;

    // Destroy existing timeline
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }

    // Create new timeline
    this.timeline = new Timeline(this.userPubkey, undefined, filterPubkeys);

    // Mount timeline
    const timelineContainer = this.container.querySelector('.timeline-view__timeline');
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
