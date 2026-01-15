/**
 * TribeView
 * PCC-View for displaying curated user timelines (tribes)
 *
 * Features:
 * - Tab-based navigation between tribes
 * - Timeline filtered to selected tribe's members
 * - "Edit" link to open TribeSecondaryManager
 * - Tabs follow folder root order
 *
 * @purpose Filtered timeline view for tribe management
 * @used-by Router (/tribes route)
 */

import { View } from './View';
import { Timeline } from '../timeline/Timeline';
import { TribeFolderService, type TribeFolder } from '../../services/TribeFolderService';
import { EventBus } from '../../services/EventBus';
import { AuthService } from '../../services/AuthService';

export class TribeView extends View {
  private container: HTMLElement;
  private timeline: Timeline | null = null;
  private tribeFolderService: TribeFolderService;
  private eventBus: EventBus;
  private authService: AuthService;
  private currentTribeId: string = ''; // Current folder ID
  private tribes: TribeFolder[] = [];

  constructor() {
    super();
    this.tribeFolderService = TribeFolderService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--tribe';
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

    // Load tribes in root order
    this.tribes = this.tribeFolderService.getFoldersInRootOrder();

    if (this.tribes.length === 0 || !this.tribes[0]) {
      this.container.innerHTML = '<div class="tribe-view__error">No tribes found. Create one in the sidebar.</div>';
      return;
    }

    // Set first tribe as current
    this.currentTribeId = this.tribes[0].id;

    // Build header with tabs and edit link
    const header = document.createElement('div');
    header.className = 'tribe-view__header';

    // Tabs container
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'tribe-view__tabs-container';

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'tabs';

    // Tribe tabs (in root order)
    for (let i = 0; i < this.tribes.length; i++) {
      const tribe = this.tribes[i];
      if (!tribe) continue;
      const isActive = i === 0; // First tribe is active
      const tab = this.createTab(tribe.id, tribe.name, isActive);
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

    // Create initial timeline for first tribe
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
    // Get member pubkeys for selected tribe
    const tribePubkeys = this.tribeFolderService.getMemberPubkeysInFolder(this.currentTribeId);

    // Destroy existing timeline
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }

    // Create new timeline with tribe filter
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
}
