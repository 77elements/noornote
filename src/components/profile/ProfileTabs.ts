/**
 * ProfileTabs - Tab navigation for User Timeline and Search Results
 * Manages switching between timeline and search results views
 */

import { switchTab, createClosableTab } from '../../helpers/TabsHelper';

export type TabType = 'timeline' | 'search';

export class ProfileTabs {
  private container: HTMLElement;
  private activeTab: TabType = 'timeline';
  private onTabChange: (tab: TabType) => void;
  private onCloseSearch: () => void;

  constructor(
    onTabChange: (tab: TabType) => void,
    onCloseSearch: () => void
  ) {
    this.onTabChange = onTabChange;
    this.onCloseSearch = onCloseSearch;
    this.container = this.createElement();
    this.setupEventListeners();
  }

  /**
   * Create tabs structure
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'profile-tabs';

    container.innerHTML = `
      <div class="tabs">
        <button class="tab tab--active" data-tab="timeline">
          User Timeline
        </button>
      </div>
    `;

    return container;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Handle tab click
      if (target.classList.contains('tab')) {
        const tab = target.dataset.tab as TabType;
        if (tab) {
          this.switchTab(tab);
        }
      }

      // Handle close button
      if (target.classList.contains('tab__close')) {
        this.onCloseSearch();
      }
    });
  }

  /**
   * Show search tab (when search is performed)
   */
  public showSearchTab(): void {
    // Check if search tab already exists
    const existingSearchTab = this.container.querySelector('[data-tab="search"]');
    if (existingSearchTab) return;

    // Add search tab using TabsHelper
    const tabsList = this.container.querySelector('.tabs');
    if (!tabsList) return;

    const searchTab = createClosableTab(
      'search',
      'Search Results',
      () => this.onCloseSearch()
    );

    tabsList.appendChild(searchTab);

    // Switch to search tab
    this.switchTab('search');
  }

  /**
   * Hide search tab (when search is closed)
   */
  public hideSearchTab(): void {
    const searchTab = this.container.querySelector('[data-tab="search"]');
    if (searchTab) {
      searchTab.remove();
    }

    // Switch back to timeline
    this.switchTab('timeline');
  }

  /**
   * Switch active tab
   */
  private switchTab(tab: TabType): void {
    this.activeTab = tab;

    // Update active state
    switchTab(this.container, tab);

    // Notify parent
    this.onTabChange(tab);
  }

  /**
   * Get current active tab
   */
  public getActiveTab(): TabType {
    return this.activeTab;
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.container.remove();
  }
}
