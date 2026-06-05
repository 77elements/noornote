/**
 * TimelineEventHandler
 * Handles user interactions for the Timeline (view changes, refresh, load more)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { TimelineModuleApi, FeedLoadRequest } from '../../../modules/timeline/contracts';
import { TimelineStateManager } from '../timeline-state/TimelineStateManager';
import { TimelineUIStateHandler } from './TimelineUIStateHandler';
import { pickDateRange, formatDateRangeLabel } from '../../../helpers/datePickerModal';
import { RefreshButton } from '../../ui/RefreshButton';
import { CustomDropdown } from '../../ui/CustomDropdown';
import { AppState } from '../../../services/AppState';
import { NoteUI } from '../../ui/NoteUI';
import { type TimelineConfig, relayFilterUrl, timeRangeOf, saveFeedMode } from '../TimelineConfig';

export class TimelineEventHandler {
  private timelineApi: TimelineModuleApi;
  private stateManager: TimelineStateManager;
  private uiStateHandler: TimelineUIStateHandler;
  private refreshButton: RefreshButton | null;
  private element: HTMLElement;
  private viewDropdown: CustomDropdown | null;
  private appState: AppState;
  private previousView: string = 'latest'; // Track previous view for cancel/revert

  // Typed use-case config, forwarded into loadMore requests (see TimelineConfig).
  private config: TimelineConfig;

  // Callbacks
  private onAppendEvents: (events: NostrEvent[]) => void;
  private onPrependEvents: (events: NostrEvent[]) => void;
  private onInitializeTimeline: () => Promise<void>;

  constructor(
    timelineApi: TimelineModuleApi,
    stateManager: TimelineStateManager,
    uiStateHandler: TimelineUIStateHandler,
    refreshButton: RefreshButton | null,
    element: HTMLElement,
    viewDropdown: CustomDropdown | null,
    config: TimelineConfig,
    callbacks: {
      onRenderEvents: () => void;
      onAppendEvents: (events: NostrEvent[]) => void;
      onPrependEvents: (events: NostrEvent[]) => void;
      onInitializeTimeline: () => Promise<void>;
    }
  ) {
    this.timelineApi = timelineApi;
    this.stateManager = stateManager;
    this.uiStateHandler = uiStateHandler;
    this.refreshButton = refreshButton;
    this.element = element;
    this.viewDropdown = viewDropdown;
    this.config = config;
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
    this.config.range = { kind: 'live' };

    // Check if this is a relay-specific filter
    if (selectedView.startsWith('relay:')) {
      const relayUrl = selectedView.substring(6); // Remove 'relay:' prefix
      this.config.relays = { kind: 'explicit', urls: [relayUrl] };
      this.config.includeReplies = false; // Reset to latest (no replies) when switching to relay

      // Update AppState so PostNoteModal can react to relay filter
      this.appState.setState('timeline', { selectedRelay: relayUrl });
    } else {
      // Standard filters (latest, latest-replies)
      this.config.relays = { kind: 'auto' }; // Clear relay filter
      this.config.includeReplies = (selectedView === 'latest-replies');

      // Remember the main timeline's feed mode so it's restored on next start.
      if (this.config.source.kind === 'following') saveFeedMode(selectedView === 'latest-replies' ? 'latest-replies' : 'latest');

      // Update AppState
      this.appState.setState('timeline', { selectedRelay: null });
    }

    // Track current view for potential revert
    this.previousView = selectedView;

    // View change requires full reload (not just prepending cached events)
    // Stop polling and clear cache from previous filter
    this.timelineApi.stopPolling();
    this.timelineApi.getPolledEvents(); // Clear cache

    // Reset state and reload
    this.stateManager.reset();
    this.element.querySelectorAll('.note-card').forEach(card => {
      const eventId = card.getAttribute('data-event-id');
      if (eventId) NoteUI.cleanup(eventId);
      card.remove();
    });
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
    const result = await pickDateRange();

    if (!result) {
      // User cancelled — revert dropdown to previous value
      if (this.viewDropdown) {
        this.viewDropdown.setValue(this.previousView);
      }
      return;
    }

    // Store date range and update dropdown label
    this.config.range = { kind: 'between', since: result.since, until: result.until };
    this.config.relays = { kind: 'auto' };
    this.config.includeReplies = false;
    this.appState.setState('timeline', { selectedRelay: null });

    if (this.viewDropdown) {
      this.viewDropdown.setCustomLabel(formatDateRangeLabel(result.since, result.until));
    }

    this.previousView = 'time-range';

    // Stop polling and clear cache
    this.timelineApi.stopPolling();
    this.timelineApi.getPolledEvents();

    // Reset state and reload with date range
    this.stateManager.reset();
    this.element.querySelectorAll('.note-card').forEach(card => {
      const eventId = card.getAttribute('data-event-id');
      if (eventId) NoteUI.cleanup(eventId);
      card.remove();
    });
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
    }
  }

  /**
   * Handle refresh button click
   */
  public async handleRefresh(): Promise<void> {
    // Get cached polled events (cleared after retrieval)
    const newEvents = this.timelineApi.getPolledEvents() ?? [];

    if (newEvents.length > 0) {
      // Prepend new events to existing timeline
      const uniqueNewEvents = this.stateManager.prependEvents(newEvents);

      if (uniqueNewEvents.length > 0) {
        // Prepend to DOM
        this.onPrependEvents(uniqueNewEvents);
      }

      // Update polling timestamp to latest event
      const latestTimestamp = newEvents.reduce((max, e) => e.created_at > max ? e.created_at : max, 0);
      this.timelineApi.resetPollingTimestamp(latestTimestamp);
    } else {
      // Fallback: Full reload if no cached events
      this.timelineApi.stopPolling();
      this.stateManager.reset();
      this.element.querySelectorAll('.note-card').forEach(card => {
      const eventId = card.getAttribute('data-event-id');
      if (eventId) NoteUI.cleanup(eventId);
      card.remove();
    });
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
    if (this.stateManager.isLoading() || !this.stateManager.getHasMore() || this.stateManager.getFollowingPubkeys().length === 0) {
      return;
    }

    this.stateManager.setLoading(true);
    this.uiStateHandler.showMoreLoading(true);

    try {
      const oldestEvent = this.stateManager.getOldestEvent();
      if (!oldestEvent) {
        this.stateManager.setHasMore(false);
        return;
      }

      // Use TimelineModuleApi for load more
      // Build request object, only adding optional properties if they have values
      const loadMoreRequest: FeedLoadRequest & { until: number } = {
        followingPubkeys: this.stateManager.getFollowingPubkeys(),
        includeReplies: this.config.includeReplies,
        until: oldestEvent.created_at,
        timeWindowHours: this.config.relays.kind === 'author-outbox' ? 720 : 3, // ProfileView: 30 days, TimelineView: 3 hours
        config: this.config
      };
      const selectedRelay = relayFilterUrl(this.config);
      if (selectedRelay) {
        loadMoreRequest.specificRelay = selectedRelay;
      }
      if (this.config.muteExemptPubkey) {
        loadMoreRequest.exemptFromMuteFilter = this.config.muteExemptPubkey; // Don't filter profile user's notes in ProfileView
      }
      // Pass date range lower bound so loadMore stops at boundary
      const dateRange = timeRangeOf(this.config);
      if (dateRange) {
        loadMoreRequest.since = dateRange.since;
      }
      const result = await this.timelineApi.loadMore(loadMoreRequest) ?? { events: [], hasMore: false };

      // Add events with deduplication
      const uniqueNewEvents = this.stateManager.addEvents(result.events);

      if (uniqueNewEvents.length > 0) {
        this.onAppendEvents(uniqueNewEvents);
      }

      this.stateManager.setHasMore(result.hasMore);

    } catch {
      // Load-more failure is non-fatal; finally resets the loading state so
      // a later scroll can retry. State stays consistent (no events added).
    } finally {
      this.stateManager.setLoading(false);
      this.uiStateHandler.showMoreLoading(false);
    }
  }
}
