/**
 * GlobalSearchView - Full-text search interface
 * Displays in .aside.secondary-content
 * Uses SearchResultsView (modular component)
 */

import { SearchOrchestrator } from '../../services/orchestration/SearchOrchestrator';
import { MuteOrchestrator } from '../../services/orchestration/MuteOrchestrator';
import { AuthService } from '../../services/AuthService';
import { SearchResultsView } from './SearchResultsView';
import { Router } from '../../services/Router';
import { EventBus } from '../../services/EventBus';
import { SystemLogger } from '../system/SystemLogger';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { deactivateAllTabs, switchTabWithContent, createClosableTab } from '../../helpers/TabsHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export class GlobalSearchView {
  private container: HTMLElement;
  private tabElement: HTMLElement | null = null;
  private searchOrchestrator: SearchOrchestrator;
  private muteOrchestrator: MuteOrchestrator;
  private authService: AuthService;
  private searchResultsView: SearchResultsView | null = null;
  private router: Router;
  private eventBus: EventBus;
  private systemLogger: SystemLogger;

  private currentQuery: string = '';
  private currentResults: NostrEvent[] = [];
  private isSearching: boolean = false;
  private oldestTimestamp: number | null = null;
  private hasMore: boolean = true;
  private isProfileSearch: boolean = false; // Track if this is profile search (no pagination)
  private currentHashtag: string = ''; // Track current hashtag for subscribe button (Phase 2)

  constructor() {
    this.searchOrchestrator = SearchOrchestrator.getInstance();
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
    this.eventBus.on('globalSearch:start', (data: { query: string }) => {
      this.performGlobalSearch(data.query);
    });

    // Listen for hashtag search start (NIP-50 relay search for hashtags)
    this.eventBus.on('hashtagSearch:start', (data: { hashtag: string }) => {
      this.performHashtagSearch(data.hashtag);
    });

    // Listen for profile search complete (client-side filtered results)
    this.eventBus.on('profileSearch:complete', (data: { query: string; results: NostrEvent[]; meta: string }) => {
      this.displayProfileSearchResults(data.query, data.results, data.meta);
    });

    // Listen for mute list updates - re-filter current results
    this.eventBus.on('mute:updated', async () => {
      if (this.currentResults.length > 0) {
        // Re-filter current results
        const filtered = await this.filterMutedUsers(this.currentResults);
        this.currentResults = filtered;
        this.renderResults();
      }
    });
  }

  /**
   * Perform global search (NIP-50 relay, no auto-load)
   */
  private async performGlobalSearch(query: string): Promise<void> {
    if (this.isSearching) return;

    this.currentQuery = query;
    this.currentHashtag = ''; // Clear hashtag (this is global search)
    this.isSearching = true;
    this.currentResults = [];
    this.oldestTimestamp = null;
    this.hasMore = true;
    this.isProfileSearch = false;

    this.showLoading();

    try {
      const results = await this.searchOrchestrator.search({
        query,
        limit: 20
      });

      // Filter out muted users
      const filteredResults = await this.filterMutedUsers(results);

      this.currentResults = filteredResults;
      this.hasMore = results.length === 20;

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
   * Perform hashtag search (NIP-50 relay search with #hashtag query)
   */
  private async performHashtagSearch(hashtag: string): Promise<void> {
    if (this.isSearching) return;

    const query = `#${hashtag}`;
    this.currentQuery = query;
    this.currentHashtag = hashtag; // Store for subscribe button (Phase 2)
    this.isSearching = true;
    this.currentResults = [];
    this.oldestTimestamp = null;
    this.hasMore = true;
    this.isProfileSearch = false;

    this.showLoading();

    try {
      const results = await this.searchOrchestrator.search({
        query,
        limit: 20
      });

      // Filter out muted users
      const filteredResults = await this.filterMutedUsers(results);

      this.currentResults = filteredResults;
      this.hasMore = results.length === 20;

      if (filteredResults.length > 0) {
        this.oldestTimestamp = Math.min(...filteredResults.map(e => e.created_at));
      }

      this.renderResults();

    } catch (error) {
      this.systemLogger.error('GlobalSearchView', 'Hashtag search failed:', error);
      this.showError('Search failed. Please try again.');
    } finally {
      this.isSearching = false;
    }
  }

  /**
   * Display profile search results (already filtered client-side)
   */
  private displayProfileSearchResults(query: string, results: NostrEvent[], meta: string): void {
    this.currentQuery = query;
    this.currentHashtag = ''; // Clear hashtag (this is profile search)
    this.currentResults = results;
    this.isProfileSearch = true;
    this.hasMore = false; // No pagination for profile search (all results already loaded)

    // Destroy previous SearchResultsView if exists
    if (this.searchResultsView) {
      this.searchResultsView.destroy();
      this.searchResultsView = null;
    }

    // Clear container
    this.container.innerHTML = '';

    // Activate search tab
    this.activateSearchTab();

    // Create SearchResultsView
    this.searchResultsView = new SearchResultsView(
      {
        title: `Profile Search: "${query}"`,
        searchTerms: query,
        meta
      },
      {
        onNoteClick: (noteId) => this.handleNoteClick(noteId),
        onLoadMore: () => {} // No pagination for profile search
      }
    );

    // Render results
    this.searchResultsView.render(results);

    // Append to container
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
      const moreResults = await this.searchOrchestrator.searchPaginated(
        {
          query: this.currentQuery,
          limit: 20
        },
        this.oldestTimestamp
      );

      // Filter out muted users
      const filteredResults = await this.filterMutedUsers(moreResults);

      if (filteredResults.length > 0) {
        this.currentResults = [...this.currentResults, ...filteredResults];
        this.oldestTimestamp = Math.min(...moreResults.map(e => e.created_at));
        this.hasMore = moreResults.length === 20;
        this.searchResultsView?.appendResults(filteredResults);
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
    // Destroy previous SearchResultsView if exists
    if (this.searchResultsView) {
      this.searchResultsView.destroy();
      this.searchResultsView = null;
    }

    // Clear container
    this.container.innerHTML = '';

    // Determine title based on search type
    const isHashtagSearch = this.currentQuery.startsWith('#');
    const title = isHashtagSearch
      ? `Posts tagged ${this.currentQuery}`
      : `Search Results: "${this.currentQuery}"`;

    // Create SearchResultsView
    this.searchResultsView = new SearchResultsView(
      {
        title,
        searchTerms: this.currentQuery,
        meta: `${this.currentResults.length} result${this.currentResults.length !== 1 ? 's' : ''} found`
      },
      {
        onNoteClick: (noteId) => this.handleNoteClick(noteId),
        onLoadMore: () => this.loadMoreResults()
      }
    );

    // Render results
    this.searchResultsView.render(this.currentResults);

    // Append to container
    this.container.appendChild(this.searchResultsView.getElement());
  }

  /**
   * Handle note click (navigate to SNV)
   */
  private handleNoteClick(noteId: string): void {
    // Navigate to SNV
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
    // Remove tab button
    if (this.tabElement) {
      this.tabElement.remove();
      this.tabElement = null;
    }

    // Clear and hide container
    this.container.innerHTML = '';
    this.container.classList.remove('tab-content--active');

    // Reset state
    this.currentQuery = '';
    this.currentHashtag = '';
    this.currentResults = [];
    if (this.searchResultsView) {
      this.searchResultsView.destroy();
      this.searchResultsView = null;
    }

    // Switch to System Logs tab
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
          const repostedAuthorTag = event.tags.find(tag => tag[0] === 'p');
          if (repostedAuthorTag && repostedAuthorTag[1]) {
            const repostedAuthorPubkey = repostedAuthorTag[1];
            if (mutedSet.has(repostedAuthorPubkey)) {
              return false;
            }
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
    this.searchResultsView?.destroy();
    this.tabElement?.remove();
    this.container.remove();
  }
}
