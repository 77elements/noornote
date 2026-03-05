/**
 * TimelineEventHandler
 * Handles user interactions for the Timeline (view changes, refresh, load more)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { FeedOrchestrator } from '../../../services/orchestration/FeedOrchestrator';
import { TimelineStateManager } from '../timeline-state/TimelineStateManager';
import { TimelineUIStateHandler } from './TimelineUIStateHandler';
import { DateRangeSelector } from './DateRangeSelector';
import { RefreshButton } from '../../ui/RefreshButton';
import { CustomDropdown } from '../../ui/CustomDropdown';
import { AppState } from '../../../services/AppState';

export class TimelineEventHandler {
  private feedOrchestrator: FeedOrchestrator;
  private stateManager: TimelineStateManager;
  private uiStateHandler: TimelineUIStateHandler;
  private refreshButton: RefreshButton | null;
  private element: HTMLElement;
  private filterAuthorPubkey?: string;
  private viewDropdown: CustomDropdown | null;
  private appState: AppState;
  private previousView: string = 'latest'; // Track previous view for cancel/revert

  // Callbacks
  private onAppendEvents: (events: NostrEvent[]) => void;
  private onPrependEvents: (events: NostrEvent[]) => void;
  private onInitializeTimeline: () => Promise<void>;

  constructor(
    feedOrchestrator: FeedOrchestrator,
    stateManager: TimelineStateManager,
    uiStateHandler: TimelineUIStateHandler,
    refreshButton: RefreshButton | null,
    element: HTMLElement,
    filterAuthorPubkey: string | undefined,
    viewDropdown: CustomDropdown | null,
    callbacks: {
      onRenderEvents: () => void;
      onAppendEvents: (events: NostrEvent[]) => void;
      onPrependEvents: (events: NostrEvent[]) => void;
      onInitializeTimeline: () => Promise<void>;
    }
  ) {
    this.feedOrchestrator = feedOrchestrator;
    this.stateManager = stateManager;
    this.uiStateHandler = uiStateHandler;
    this.refreshButton = refreshButton;
    this.element = element;
    if (filterAuthorPubkey) {
      this.filterAuthorPubkey = filterAuthorPubkey;
    }
    this.viewDropdown = viewDropdown;
    this.appState = AppState.getInstance();
    this.onAppendEvents = callbacks.onAppendEvents;
    this.onPrependEvents = callbacks.onPrependEvents;
    this.onInitializeTimeline = callbacks.onInitializeTimeline;
  }

  /**
   * Handle load more request from infinite scroll component
   */
  public handleLoadMore(): void {
    if (!this.stateManager.isLoading() && this.stateManager.getHasMore() && this.stateManager.getFollowingPubkeys().length > 0) {
      this.loadMoreEvents();
    }
  }

  /**
   * Handle timeline view change
   */
  public async handleViewChange(selectedView: string): Promise<void> {
    // Time Range: open modal instead of immediate reload
    if (selectedView === 'time-range') {
      await this.handleTimeRangeSelection();
      return;
    }

    // Clear date range when switching away from time range mode
    this.stateManager.clearDateRange();

    // Check if this is a relay-specific filter
    if (selectedView.startsWith('relay:')) {
      const relayUrl = selectedView.substring(6); // Remove 'relay:' prefix
      this.stateManager.setSelectedRelay(relayUrl);
      this.stateManager.setIncludeReplies(false); // Reset to latest (no replies) when switching to relay

      // Update AppState so PostNoteModal can react to relay filter
      this.appState.setState('timeline', { selectedRelay: relayUrl });
    } else {
      // Standard filters (latest, latest-replies)
      this.stateManager.setSelectedRelay(null); // Clear relay filter
      this.stateManager.setIncludeReplies(selectedView === 'latest-replies');

      // Update AppState
      this.appState.setState('timeline', { selectedRelay: null });
    }

    // Track current view for potential revert
    this.previousView = selectedView;

    // View change requires full reload (not just prepending cached events)
    // Stop polling and clear cache from previous filter
    this.feedOrchestrator.stopPolling();
    this.feedOrchestrator.getPolledEvents(); // Clear cache

    // Reset state and reload
    this.stateManager.reset();
    this.element.querySelectorAll('.note-card').forEach(card => card.remove());
    await this.onInitializeTimeline();

    // Hide refresh button
    if (this.refreshButton) {
      this.refreshButton.hide();
    }
  }

  /**
   * Handle time range selection via modal
   */
  private async handleTimeRangeSelection(): Promise<void> {
    const selector = new DateRangeSelector();
    const result = await selector.show();

    if (!result) {
      // User cancelled — revert dropdown to previous value
      if (this.viewDropdown) {
        this.viewDropdown.setValue(this.previousView);
      }
      return;
    }

    // Store date range and update dropdown label
    this.stateManager.setDateRange(result);
    this.stateManager.setSelectedRelay(null);
    this.stateManager.setIncludeReplies(false);
    this.appState.setState('timeline', { selectedRelay: null });

    if (this.viewDropdown) {
      this.viewDropdown.setCustomLabel(DateRangeSelector.formatRangeLabel(result.since, result.until));
    }

    this.previousView = 'time-range';

    // Stop polling and clear cache
    this.feedOrchestrator.stopPolling();
    this.feedOrchestrator.getPolledEvents();

    // Reset state and reload with date range
    this.stateManager.reset();
    this.element.querySelectorAll('.note-card').forEach(card => card.remove());
    await this.onInitializeTimeline();

    // Hide refresh button (no polling in time range mode)
    if (this.refreshButton) {
      this.refreshButton.hide();
    }
  }

  /**
   * Handle refresh button click
   * Prepends new notes AND scrolls to top (like Timeline menu link)
   */
  public async handleRefreshClick(): Promise<void> {
    await this.handleRefresh();

    // Scroll to top so user sees the new notes
    // Timeline is inside .timeline-view__timeline (scrollable container)
    const scrollContainer = this.element.parentElement;
    if (scrollContainer && scrollContainer.classList.contains('timeline-view__timeline')) {
      scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
      // Reset scroll position in AppState
      this.appState.setState('timeline', { scrollPosition: 0 });
    }
  }

  /**
   * Handle refresh button click
   */
  public async handleRefresh(): Promise<void> {
    // Get cached polled events (cleared after retrieval)
    const newEvents = this.feedOrchestrator.getPolledEvents();

    if (newEvents.length > 0) {
      // Prepend new events to existing timeline
      const uniqueNewEvents = this.stateManager.prependEvents(newEvents);

      if (uniqueNewEvents.length > 0) {
        // Prepend to DOM
        this.onPrependEvents(uniqueNewEvents);
      }

      // Update polling timestamp to latest event
      const latestTimestamp = newEvents.reduce((max, e) => e.created_at > max ? e.created_at : max, 0);
      this.feedOrchestrator.resetPollingTimestamp(latestTimestamp);
    } else {
      // Fallback: Full reload if no cached events
      this.feedOrchestrator.stopPolling();
      this.stateManager.reset();
      this.element.querySelectorAll('.note-card').forEach(card => card.remove());
      await this.onInitializeTimeline();
    }

    // Hide refresh button
    if (this.refreshButton) {
      this.refreshButton.hide();
    }
  }

  /**
   * Load more events for infinite scroll - pure UI orchestration
   */
  private async loadMoreEvents(): Promise<void> {
    console.log('🔄 INFINITE SCROLL TRIGGERED');

    if (this.stateManager.isLoading() || !this.stateManager.getHasMore() || this.stateManager.getFollowingPubkeys().length === 0) {
      console.log('❌ Infinite scroll blocked:', { loading: this.stateManager.isLoading(), hasMore: this.stateManager.getHasMore() });
      return;
    }

    this.stateManager.setLoading(true);
    this.uiStateHandler.showMoreLoading(true);

    try {
      const oldestEvent = this.stateManager.getOldestEvent();
      if (!oldestEvent) {
        console.log('⚠️ No oldest event found');
        this.stateManager.setHasMore(false);
        return;
      }

      // Use FeedOrchestrator for load more
      // Build request object, only adding optional properties if they have values
      const loadMoreRequest: Parameters<typeof this.feedOrchestrator.loadMore>[0] = {
        followingPubkeys: this.stateManager.getFollowingPubkeys(),
        includeReplies: this.stateManager.getIncludeReplies(),
        until: oldestEvent.created_at,
        timeWindowHours: this.filterAuthorPubkey ? 720 : 3 // ProfileView: 30 days, TimelineView: 3 hours
      };
      const selectedRelay = this.stateManager.getSelectedRelay();
      if (selectedRelay) {
        loadMoreRequest.specificRelay = selectedRelay;
      }
      if (this.filterAuthorPubkey) {
        loadMoreRequest.exemptFromMuteFilter = this.filterAuthorPubkey; // Don't filter profile user's notes in ProfileView
      }
      // Pass date range lower bound so loadMore stops at boundary
      const dateRange = this.stateManager.getDateRange();
      if (dateRange) {
        loadMoreRequest.since = dateRange.since;
      }
      const result = await this.feedOrchestrator.loadMore(loadMoreRequest);

      // Add events with deduplication
      const uniqueNewEvents = this.stateManager.addEvents(result.events);

      if (uniqueNewEvents.length > 0) {
        console.log(`📝 Adding ${uniqueNewEvents.length} new events to timeline`);
        this.onAppendEvents(uniqueNewEvents);
      } else {
        console.log('⚠️ No unique events to add (all were duplicates)');
        console.log(`🔍 EXISTING IDs:`, this.stateManager.getEvents().slice(0, 5).map(e => e.id?.slice(0, 8)));
        console.log(`🔍 NEW IDs:`, result.events.slice(0, 5).map(e => e.id?.slice(0, 8)));
      }

      this.stateManager.setHasMore(result.hasMore);
      console.log(`📱 LOAD MORE UI: ${uniqueNewEvents.length} new events, hasMore: ${result.hasMore}`);

    } catch (error) {
      console.error('💥 INFINITE SCROLL ERROR:', error);
    } finally {
      this.stateManager.setLoading(false);
      this.uiStateHandler.showMoreLoading(false);
    }
  }
}
