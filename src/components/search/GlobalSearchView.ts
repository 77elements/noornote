/**
 * GlobalSearchView - Full-text search interface
 * Displays in .aside.secondary-content
 * Uses SearchResultsView (modular component)
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { SearchModuleApi } from '../../modules/search/contracts';
import { MuteOrchestrator } from '../../lists/mutes';
import { AuthService } from '../../services/AuthService';
import { SearchResultsView, SearchResultsConfig } from './SearchResultsView';
import { Router } from '../../services/Router';
import { EventBus } from '../../services/EventBus';
import { SystemLogger } from '../../services/SystemLogger';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { deactivateAllTabs, switchTabWithContent, createClosableTab } from '../../helpers/TabsHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export class GlobalSearchView {
  private container: HTMLElement;
  private tabElement: HTMLElement | null = null;
  private _searchApi: SearchModuleApi | null = null;
  private get searchApi(): SearchModuleApi | null {
    if (!this._searchApi) {
      this._searchApi = ModuleLoader.getInstance().getApi<SearchModuleApi>('search');
    }
    return this._searchApi;
  }
  private muteOrchestrator: ReturnType<typeof MuteOrchestrator.getInstance>;
  private authService: AuthService;
  private searchResultsView: SearchResultsView | null = null;
  private router: Router;
  private eventBus: EventBus;
  private systemLogger: SystemLogger;
  private eventBusSubscriptions: string[] = [];

  private currentQuery: string = '';
  private currentResults: NostrEvent[] = [];
  private isSearching: boolean = false;
  private oldestTimestamp: number | null = null;
  private hasMore: boolean = true;
  private isProfileSearch: boolean = false; // Track if this is profile search (no pagination)
  private currentHashtag: string = ''; // Track current hashtag for subscribe button (Phase 2)

  constructor() {
    // searchApi resolved lazily via getter
    this.muteOrchestrator = MuteOrchestrator.getInstance();
    this.authService = AuthService.getInstance();
    this.router = Router.getInstance();
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.container = this.createElement();
    this.setupEventListeners();
  }

  /**
   * Create container element (tab-content style)
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'tab-content global-search-view';
    container.dataset.tabContent = 'search-results';
    return container;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for global search start (NIP-50 relay search)
    this.eventBusSubscriptions.push(
      this.eventBus.on('globalSearch:start', (data: { query: string }) => {
        this.performGlobalSearch(data.query);
      })
    );

    // Listen for hashtag search start (NIP-50 relay search for hashtags)
    this.eventBusSubscriptions.push(
      this.eventBus.on('hashtagSearch:start', (data: { hashtag: string }) => {
        this.performHashtagSearch(data.hashtag);
      })
    );

    // Listen for profile search complete (client-side filtered results)
    this.eventBusSubscriptions.push(
      this.eventBus.on('profileSearch:complete', (data: { query: string; results: NostrEvent[]; meta: string }) => {
        this.displayProfileSearchResults(data.query, data.results, data.meta);
      })
    );

    // Listen for mute list updates - re-filter current results
    this.eventBusSubscriptions.push(
      this.eventBus.on('mute:updated', async () => {
        if (this.currentResults.length > 0) {
          // Re-filter current results
          const filtered = await this.filterMutedUsers(this.currentResults);
          this.currentResults = filtered;
          this.renderResults();
        }
      })
    );
  }

  /**
   * Perform global search (NIP-50 relay, no auto-load)
   */
  private async performGlobalSearch(query: string): Promise<void> {
    await this.executeSearch(query, '');
  }

  /**
   * Perform hashtag search (NIP-50 relay search with #hashtag query)
   */
  private async performHashtagSearch(hashtag: string): Promise<void> {
    await this.executeSearch(`#${hashtag}`, hashtag);
  }

  /**
   * Execute search with given query and optional hashtag context
   */
  private async executeSearch(query: string, hashtag: string): Promise<void> {
    if (this.isSearching) return;

    this.resetSearchState(query, hashtag);
    this.showLoading();

    try {
      const results = await this.searchApi?.search({
        query,
        limit: 50
      }) ?? [];

      const filteredResults = await this.filterMutedUsers(results);

      filteredResults.sort((a, b) => b.created_at - a.created_at);

      this.currentResults = filteredResults;
      this.hasMore = results.length >= 50;

      if (filteredResults.length > 0) {
        this.oldestTimestamp = Math.min(...filteredResults.map(e => e.created_at));
      }

      this.renderResults();
    } catch (error) {
      this.systemLogger.error('GlobalSearchView', 'Search failed:', error);
      this.showError('Search failed. Please try again.');
    } finally {
      this.isSearching = false;
    }
  }

  /**
   * Reset search state for a new search
   */
  private resetSearchState(query: string, hashtag: string): void {
    this.currentQuery = query;
    this.currentHashtag = hashtag;
    this.isSearching = true;
    this.currentResults = [];
    this.oldestTimestamp = null;
    this.hasMore = true;
    this.isProfileSearch = false;
  }

  /**
   * Display profile search results (already filtered client-side)
   */
  private displayProfileSearchResults(query: string, results: NostrEvent[], meta: string): void {
    this.currentQuery = query;
    this.currentHashtag = '';
    this.currentResults = results;
    this.isProfileSearch = true;
    this.hasMore = false;

    this.clearSearchResultsView();
    this.activateSearchTab();

    this.searchResultsView = new SearchResultsView(
      {
        title: `Profile Search: "${query}"`,
        searchTerms: query,
        meta
      },
      {
        onNoteClick: (noteId) => this.handleNoteClick(noteId),
        onLoadMore: async () => {}
      }
    );

    this.searchResultsView.render(results);
    this.container.appendChild(this.searchResultsView.getElement());
  }

  /**
   * Load more results (for InfiniteScroll - only for global search)
   */
  private async loadMoreResults(): Promise<void> {
    // Don't paginate profile search results (already loaded all)
    if (this.isProfileSearch || this.isSearching || !this.hasMore || !this.oldestTimestamp) return;

    this.isSearching = true;
    this.searchResultsView?.showLoading();

    try {
      // Use oldestTimestamp - 1 to avoid duplicates (like Jumble does)
      const moreResults = await this.searchApi?.searchPaginated(
        {
          query: this.currentQuery,
          limit: 50
        },
        this.oldestTimestamp - 1
      ) ?? [];

      const filteredResults = await this.filterMutedUsers(moreResults);

      if (filteredResults.length > 0) {
        filteredResults.sort((a, b) => b.created_at - a.created_at);

        this.currentResults = [...this.currentResults, ...filteredResults];
        this.oldestTimestamp = Math.min(...moreResults.map(e => e.created_at));
        this.hasMore = moreResults.length >= 50;
        this.searchResultsView?.appendResults(filteredResults);

        // Update meta with new total count
        const newMeta = `${this.currentResults.length} result${this.currentResults.length !== 1 ? 's' : ''} found`;
        this.searchResultsView?.updateMeta(newMeta);
      } else {
        this.hasMore = false;
      }

    } catch (error) {
      this.systemLogger.error('GlobalSearchView', 'Load more failed:', error);
    } finally {
      this.searchResultsView?.hideLoading();
      this.isSearching = false;
    }
  }

  /**
   * Show loading state
   */
  private showLoading(): void {
    // Switch to search results tab
    this.activateSearchTab();

    this.container.innerHTML = `
      <div class="infinite-scroll-loading" style="display: flex;">
        <p>Searching...</p>
      </div>
    `;
  }

  /**
   * Show error state
   */
  private showError(message: string): void {
    this.container.innerHTML = `
      <div class="global-search-error">
        <p>${message}</p>
      </div>
    `;
  }

  /**
   * Render search results
   */
  private renderResults(): void {
    this.clearSearchResultsView();

    const isHashtagSearch = this.currentQuery.startsWith('#');
    const title = isHashtagSearch
      ? `Posts tagged ${this.currentQuery}`
      : `Search Results: "${this.currentQuery}"`;

    const config: SearchResultsConfig = {
      title,
      searchTerms: this.currentQuery,
      meta: `${this.currentResults.length} result${this.currentResults.length !== 1 ? 's' : ''} found`
    };
    if (this.currentHashtag) {
      config.hashtag = this.currentHashtag;
    }

    this.searchResultsView = new SearchResultsView(
      config,
      {
        onNoteClick: (noteId) => this.handleNoteClick(noteId),
        onLoadMore: () => this.loadMoreResults()
      }
    );

    this.searchResultsView.render(this.currentResults);
    this.container.appendChild(this.searchResultsView.getElement());
  }

  /**
   * Clear existing SearchResultsView and container
   */
  private clearSearchResultsView(): void {
    if (this.searchResultsView) {
      this.searchResultsView.destroy();
      this.searchResultsView = null;
    }
    this.container.innerHTML = '';
  }

  /**
   * Handle note click - navigate to Single Note View
   */
  private handleNoteClick(noteId: string): void {
    const nevent = encodeNevent(noteId);
    this.router.navigate(`/note/${nevent}`);
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Activate search tab (make visible and switch tabs)
   */
  private activateSearchTab(): void {
    this.ensureSearchTabButton();

    // Deactivate all tabs in secondary-content
    const secondaryContent = document.querySelector('.secondary-content');
    if (secondaryContent) {
      deactivateAllTabs(secondaryContent as HTMLElement);
    }

    // Activate search tab button
    if (this.tabElement) {
      this.tabElement.classList.add('tab--active');
    }

    // Activate search content
    this.container.classList.add('tab-content--active');
  }

  /**
   * Ensure search tab button exists in tabs container
   */
  private ensureSearchTabButton(): void {
    const tabsContainer = document.querySelector('#sidebar-tabs');
    if (!tabsContainer) return;

    // Check if tab already exists
    if (this.tabElement && tabsContainer.contains(this.tabElement)) return;

    // Create new tab button using TabsHelper
    const searchTab = createClosableTab(
      'search-results',
      'Search Results',
      () => this.closeSearchTab()
    );

    // Tab click handler
    searchTab.addEventListener('click', () => {
      this.activateSearchTab();
    });

    // Append to tabs container
    tabsContainer.appendChild(searchTab);
    this.tabElement = searchTab;
  }

  /**
   * Close search tab and switch to System Logs
   */
  private closeSearchTab(): void {
    if (this.tabElement) {
      this.tabElement.remove();
      this.tabElement = null;
    }

    this.clearSearchResultsView();
    this.container.classList.remove('tab-content--active');

    this.currentQuery = '';
    this.currentHashtag = '';
    this.currentResults = [];

    const secondaryContent = document.querySelector('.secondary-content');
    if (secondaryContent) {
      switchTabWithContent(secondaryContent as HTMLElement, 'system-log');
    }
  }

  /**
   * Filter out events from muted users
   * Filters both direct posts and reposts where original author is muted
   * @param events Array of events to filter
   * @returns Filtered array
   */
  private async filterMutedUsers(events: NostrEvent[]): Promise<NostrEvent[]> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return events; // No user logged in, no filtering
    }

    try {
      // Get all muted pubkeys
      const mutedPubkeys = await this.muteOrchestrator.getAllMutedUsers(currentUser.pubkey);
      const mutedSet = new Set(mutedPubkeys);

      if (mutedSet.size === 0) {
        return events; // No muted users
      }

      return events.filter(event => {
        // Filter direct posts from muted users
        if (mutedSet.has(event.pubkey)) {
          return false;
        }

        // Filter reposts (Kind 6) where the original author is muted
        if (event.kind === 6) {
          const repostedAuthorPubkey = event.tags.find(tag => tag[0] === 'p')?.[1];
          if (repostedAuthorPubkey && mutedSet.has(repostedAuthorPubkey)) {
            return false;
          }
        }

        return true;
      });
    } catch (error) {
      this.systemLogger.error('GlobalSearchView', 'Failed to filter muted users:', error);
      return events; // Return unfiltered on error
    }
  }

  /**
   * Hide search view
   */
  public hide(): void {
    this.container.classList.remove('tab-content--active');
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.eventBusSubscriptions.forEach(id => this.eventBus.off(id));
    this.eventBusSubscriptions = [];
    this.searchResultsView?.destroy();
    this.tabElement?.remove();
    this.container.remove();
  }
}
