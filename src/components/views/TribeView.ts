/**
 * TribeView
 * PCC-View for displaying curated user timelines (tribes)
 *
 * Features:
 * - Tab-based navigation between tribes
 * - "All" tab showing all tribe members
 * - Timeline filtered to selected tribe's members
 * - "Edit" link to open TribeSecondaryManager
 *
 * @purpose Filtered timeline view for tribe management
 * @used-by Router (/tribes route)
 */

import { View } from './View';
import { Timeline } from '../timeline/Timeline';
import { TribeFolderService, type TribeFolder } from '../../services/TribeFolderService';
import { TribeStorageAdapter } from '../../services/sync/adapters/TribeStorageAdapter';
import { EventBus } from '../../services/EventBus';
import { AuthService } from '../../services/AuthService';

export class TribeView extends View {
  private container: HTMLElement;
  private timeline: Timeline | null = null;
  private tribeFolderService: TribeFolderService;
  private tribeStorageAdapter: TribeStorageAdapter;
  private eventBus: EventBus;
  private authService: AuthService;
  private currentTribeId: string = 'all'; // 'all' or folder ID
  private tribes: TribeFolder[] = [];

  constructor() {
    super();
    this.tribeFolderService = TribeFolderService.getInstance();
    this.tribeStorageAdapter = new TribeStorageAdapter();
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.container = document.createElement('div');
    this.container.className = 'tribe-view';
    this.render();
  }

  /**
   * Render the view
   */
  private async render(): Promise<void> {
    // Get current user
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.container.innerHTML = '<div class="tribe-view__error">Please login to view tribes</div>';
      return;
    }

    // Load tribes
    this.tribes = this.tribeFolderService.getFolders();

    // Build header with tabs and edit link
    const header = document.createElement('div');
    header.className = 'tribe-view__header';

    // Tabs container
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'tribe-view__tabs-container';

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'tabs';

    // "All" tab
    const allTab = this.createTab('all', 'All', true);
    tabs.appendChild(allTab);

    // Tribe tabs
    for (const tribe of this.tribes) {
      const tab = this.createTab(tribe.id, tribe.name, false);
      tabs.appendChild(tab);
    }

    tabsContainer.appendChild(tabs);

    // Edit link
    const editLink = document.createElement('button');
    editLink.className = 'tribe-view__edit-link';
    editLink.textContent = 'Edit ›';
    editLink.addEventListener('click', () => {
      this.eventBus.emit('list:open', { listType: 'tribes' });
    });

    tabsContainer.appendChild(editLink);
    header.appendChild(tabsContainer);
    this.container.appendChild(header);

    // Timeline container
    const timelineContainer = document.createElement('div');
    timelineContainer.className = 'tribe-view__timeline';
    this.container.appendChild(timelineContainer);

    // Create initial timeline for "All" members
    await this.updateTimeline(currentUser.pubkey);
  }

  /**
   * Create a tab button
   */
  private createTab(tribeId: string, name: string, isActive: boolean): HTMLElement {
    const tab = document.createElement('button');
    tab.className = isActive ? 'tab tab--active' : 'tab';
    tab.dataset.tribeId = tribeId;
    tab.textContent = name;

    tab.addEventListener('click', async () => {
      // Update active state
      const allTabs = this.container.querySelectorAll('.tab');
      allTabs.forEach(t => t.classList.remove('tab--active'));
      tab.classList.add('tab--active');

      // Update current tribe
      this.currentTribeId = tribeId;

      // Reload timeline
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        await this.updateTimeline(currentUser.pubkey);
      }
    });

    return tab;
  }

  /**
   * Update timeline based on selected tribe
   */
  private async updateTimeline(userPubkey: string): Promise<void> {
    // Get pubkeys for selected tribe
    let tribePubkeys: string[];

    if (this.currentTribeId === 'all') {
      // All members from all tribes
      const allMembers = this.tribeStorageAdapter.getBrowserItems();
      tribePubkeys = allMembers.map(m => m.pubkey);
    } else {
      // Members from specific tribe
      tribePubkeys = this.tribeFolderService.getMembersInFolder(this.currentTribeId);
    }

    // Destroy existing timeline
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }

    // Create new timeline with tribe filter
    // Note: Timeline.ts needs to be updated to support tribePubkeys parameter
    this.timeline = new Timeline(userPubkey, undefined, tribePubkeys);

    // Mount timeline
    const timelineContainer = this.container.querySelector('.tribe-view__timeline');
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
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }
    this.container.innerHTML = '';
  }

  /**
   * Pause timeline when navigating away
   */
  public pause(): void {
    if (this.timeline) {
      this.timeline.pause();
    }
  }

  /**
   * Resume timeline when navigating back
   */
  public resume(): void {
    if (this.timeline) {
      this.timeline.resume();
    }
  }
}
