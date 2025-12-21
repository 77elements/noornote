/**
 * Timeline UI
 * Pure UI component for displaying timeline events
 * Uses FeedOrchestrator for data fetching
 */

import { View } from '../views/View';
import { FeedOrchestrator, type NewNotesInfo } from '../../services/orchestration/FeedOrchestrator';
import { UserService } from '../../services/UserService';
import { RelayConfig } from '../../services/RelayConfig';
import { AuthService } from '../../services/AuthService';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { RefreshButton } from '../ui/RefreshButton';
import { CustomDropdown } from '../ui/CustomDropdown';
import { TimelineStateManager } from './timeline-state/TimelineStateManager';
import { TimelineLifecycleManager } from './timeline-state/TimelineLifecycleManager';
import { TimelineUIStateHandler } from './timeline-ui/TimelineUIStateHandler';
import { TimelineEventHandler } from './timeline-ui/TimelineEventHandler';
import { TimelineRenderer } from './timeline-ui/TimelineRenderer';
import { ISLStatsUpdater } from './timeline-features/ISLStatsUpdater';
import { ScrollPositionManager } from './timeline-features/ScrollPositionManager';
import { EventBus } from '../../services/EventBus';
import { CacheManager } from '../../services/CacheManager';

export class Timeline extends View {
  private element: HTMLElement;
  private feedOrchestrator: FeedOrchestrator;
  private userService: UserService;
  private relayConfig: RelayConfig;
  private authService: AuthService;
  private infiniteScroll: InfiniteScroll;
  private userPubkey: string;
  private filterAuthorPubkey?: string; // Optional: filter timeline to specific author (for ProfileView)
  private tribePubkeys?: string[]; // Optional: filter timeline to tribe members (for TribeView)
  private refreshButton: RefreshButton | null = null;
  private viewDropdown: CustomDropdown | null = null;

  // Managers
  private stateManager: TimelineStateManager;
  private lifecycleManager: TimelineLifecycleManager;
  private uiStateHandler: TimelineUIStateHandler;
  private eventHandler!: TimelineEventHandler;
  private renderer!: TimelineRenderer;
  private islStatsUpdater: ISLStatsUpdater;
  private scrollPositionManager: ScrollPositionManager;

  // EventBus subscription
  private eventBus: EventBus;
  private userLoginSubscriptionId?: string;

  constructor(userPubkey: string, filterAuthorPubkey?: string, tribePubkeys?: string[]) {
    super(); // Call View base class constructor
    this.userPubkey = userPubkey;
    this.filterAuthorPubkey = filterAuthorPubkey;
    this.tribePubkeys = tribePubkeys;
    this.feedOrchestrator = FeedOrchestrator.getInstance();
    this.userService = UserService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.element = this.createElement();
    this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
      loadingMessage: 'Loading more notes...'
    });

    // Initialize managers
    this.stateManager = new TimelineStateManager();
    this.lifecycleManager = new TimelineLifecycleManager(this.feedOrchestrator, this.infiniteScroll);
    this.uiStateHandler = new TimelineUIStateHandler(this.element);
    this.islStatsUpdater = new ISLStatsUpdater(this.element);
    this.scrollPositionManager = new ScrollPositionManager(this.element);

    // Initialize renderer
    this.renderer = new TimelineRenderer(this.element, this.stateManager, this.uiStateHandler);

    this.setupViewDropdown();
    this.setupInfiniteScroll();
    this.setupRefreshButton();

    // Initialize event handler (requires refresh button and renderer to be set up first)
    this.eventHandler = new TimelineEventHandler(
      this.feedOrchestrator,
      this.stateManager,
      this.uiStateHandler,
      this.refreshButton,
      this.element,
      this.filterAuthorPubkey,
      {
        onRenderEvents: () => this.renderer.renderEvents(),
        onAppendEvents: (events) => this.renderer.appendNewEvents(events),
        onPrependEvents: (events) => this.renderer.prependNewEvents(events),
        onInitializeTimeline: () => this.initializeTimeline()
      }
    );

    // Listen for NSFW preference changes
    this.setupNSFWPreferenceListener();

    // Listen for mute list updates
    this.setupMuteListener();

    // Listen for note deletions
    this.setupDeleteListener();

    // Listen for user account switches (only for main timeline, not ProfileView)
    if (!this.filterAuthorPubkey) {
      this.setupUserLoginListener();
    }

    this.initializeTimeline();
  }

  /**
   * Get the pubkey this timeline was created for
   */
  public getPubkey(): string {
    return this.userPubkey;
  }

  /**
   * Setup listener for NSFW preference changes
   */
  private setupNSFWPreferenceListener(): void {
    window.addEventListener('nsfw-preference-changed', () => {
      // Re-render timeline with new blur settings
      this.renderer.renderEvents();
    });
  }

  /**
   * Setup listener for mute list updates
   */
  private setupMuteListener(): void {
    this.eventBus.on('mute:updated', async () => {
      // Re-fetch feed with updated mute list
      await this.eventHandler.handleRefreshClick();
    });
  }

  /**
   * Setup listener for note deletions
   */
  private setupDeleteListener(): void {
    this.eventBus.on('note:deleted', (data: { eventId: string }) => {
      // Remove note from state
      this.stateManager.removeEvent(data.eventId);

      // Re-render timeline without the deleted note
      this.renderer.renderEvents();
    });
  }

  /**
   * Setup listener for user account switches
   * When user switches accounts, clear caches and reinitialize timeline
   */
  private setupUserLoginListener(): void {
    this.userLoginSubscriptionId = this.eventBus.on('user:login', (data: { pubkey: string }) => {
      // Only reinitialize if pubkey actually changed
      if (data.pubkey !== this.userPubkey) {
        console.log(`[Timeline] User switched from ${this.userPubkey.slice(0, 8)}... to ${data.pubkey.slice(0, 8)}...`);

        // Clear user-specific caches
        CacheManager.getInstance().clearUserSpecificCaches();

        // Update pubkey and reinitialize
        this.userPubkey = data.pubkey;
        this.reinitialize();
      }
    });
  }

  /**
   * Reinitialize timeline for new user
   * Stops polling, clears state, and loads new user's feed
   */
  private async reinitialize(): Promise<void> {
    // Stop polling and clear state
    this.lifecycleManager.pause();
    this.stateManager.clear();

    // Clear existing content
    const eventsContainer = this.element.querySelector('.timeline-events');
    if (eventsContainer) {
      eventsContainer.innerHTML = '';
    }

    // Reinitialize timeline with new user
    await this.initializeTimeline();
  }

  /**
   * Create the timeline container
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'timeline';
    container.innerHTML = `
      <div class="timeline-header">
        <div class="timeline-view-selector">
          <!-- Custom dropdown will be mounted here -->
        </div>
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
        <h3>No events found</h3>
        <p>Follow some users or check your relay connections.</p>
      </div>
    `;

    return container;
  }

  /**
   * Setup custom dropdown for view selection
   */
  private setupViewDropdown(): void {
    // Build dropdown options: Latest, Latest+Replies, then user's relays (no aggregators)
    const baseOptions = [
      { value: 'latest', label: 'Latest' },
      { value: 'latest-replies', label: 'Latest + Replies' }
    ];

    // Get user-configured read relays (excludes aggregator relays)
    const userRelays = this.relayConfig.getUserReadRelays();
    const relayOptions = userRelays.map(relayUrl => {
      // Extract domain from relay URL for label (remove wss:// or ws://)
      const label = relayUrl.replace(/^wss?:\/\//, '');
      return { value: `relay:${relayUrl}`, label };
    });

    const allOptions = [...baseOptions, ...relayOptions];

    this.viewDropdown = new CustomDropdown({
      options: allOptions,
      selectedValue: 'latest',
      onChange: (value: string) => this.eventHandler.handleViewChange(value),
      className: 'timeline-view-dropdown',
      width: '220px' // Wider to accommodate relay URLs
    });

    // Register with lifecycle manager for cleanup
    this.lifecycleManager.setViewDropdown(this.viewDropdown);

    // Mount dropdown
    const viewSelector = this.element.querySelector('.timeline-view-selector');
    if (viewSelector) {
      viewSelector.appendChild(this.viewDropdown.getElement());
    }
  }

  /**
   * Setup infinite scroll component
   */
  private setupInfiniteScroll(): void {
    const loadTrigger = this.element.querySelector('.timeline-load-trigger') as HTMLElement;
    if (loadTrigger) {
      this.infiniteScroll.observe(loadTrigger);
    }
  }

  /**
   * Setup refresh button for new notes
   */
  private setupRefreshButton(): void {
    this.refreshButton = new RefreshButton({
      newNotesCount: 0,
      authorPubkeys: [],
      onClick: () => this.eventHandler.handleRefreshClick()
    });

    // Register with lifecycle manager for cleanup
    this.lifecycleManager.setRefreshButton(this.refreshButton);

    // Replace the old refresh button with new one
    const controls = this.element.querySelector('.timeline-controls');
    if (controls) {
      const oldRefreshBtn = controls.querySelector('[data-action="refresh"]');
      if (oldRefreshBtn) {
        oldRefreshBtn.replaceWith(this.refreshButton.getElement());
      }
    }
  }

  /**
   * Handle load more request from infinite scroll component
   */
  private handleLoadMore(): void {
    this.eventHandler.handleLoadMore();
  }

  /**
   * Initialize timeline loading - pure UI orchestration
   */
  private async initializeTimeline(): Promise<void> {
    this.stateManager.setLoading(true);

    // Show skeleton loaders immediately (better UX than spinner)
    this.uiStateHandler.showSkeletonLoaders(5);

    try {
      // Wait for auth to be fully initialized (session restore, NIP-46, etc.)
      await this.authService.waitForInitialization();

      // Get authors to fetch: tribe members, specific author, or following list
      if (this.tribePubkeys && this.tribePubkeys.length > 0) {
        // TribeView: show notes from tribe members
        this.stateManager.setFollowingPubkeys(this.tribePubkeys);
        console.log(`📱 TIMELINE UI: Loading notes from ${this.tribePubkeys.length} tribe members`);

        if (this.tribePubkeys.length === 0) {
          this.uiStateHandler.hideSkeletonLoaders();
          this.uiStateHandler.showError('No members in this tribe. Add some members to see their notes.');
          return;
        }
      } else if (this.filterAuthorPubkey) {
        // ProfileView: show only this author's notes
        this.stateManager.setFollowingPubkeys([this.filterAuthorPubkey]);
        console.log(`📱 TIMELINE UI: Loading notes for author: ${this.filterAuthorPubkey.slice(0, 8)}...`);
      } else {
        // TimelineView: show following list + current user's own posts
        let followingPubkeys = await this.userService.getUserFollowing(this.userPubkey);

        // Add current user to the list (to see own posts in timeline)
        if (!followingPubkeys.includes(this.userPubkey)) {
          followingPubkeys = [...followingPubkeys, this.userPubkey];
        }

        this.stateManager.setFollowingPubkeys(followingPubkeys);
        console.log(`📱 Building Timeline from ${followingPubkeys.length} followed users`);

        if (followingPubkeys.length <= 1) {
          this.uiStateHandler.hideSkeletonLoaders();
          this.uiStateHandler.showError('No following list found. Please follow some users first.');
          return;
        }
      }

      // Use FeedOrchestrator for loading
      const result = await this.feedOrchestrator.loadInitialFeed({
        followingPubkeys: this.stateManager.getFollowingPubkeys(),
        includeReplies: this.stateManager.getIncludeReplies(),
        timeWindowHours: 1, // Both ProfileView and TimelineView start with 1h (auto-load extends if needed)
        specificRelay: this.stateManager.getSelectedRelay() || undefined,
        exemptFromMuteFilter: this.filterAuthorPubkey // Don't filter profile user's notes in ProfileView
      });

      this.stateManager.setEvents(result.events);

      // Hide skeletons and render actual events
      this.uiStateHandler.hideSkeletonLoaders();
      this.renderer.renderEvents();

      this.stateManager.setHasMore(result.hasMore);

      // Start polling for new notes after 10 seconds
      this.startNewNotesPolling();

    } catch (error) {
      console.error('Failed to initialize timeline:', error);
      this.uiStateHandler.hideSkeletonLoaders();
      this.uiStateHandler.showError('Failed to load timeline. Please check your connection.');
    } finally {
      this.stateManager.setLoading(false);
    }
  }

  /**
   * Start polling for new notes
   */
  private startNewNotesPolling(): void {
    const newestTimestamp = this.stateManager.getNewestTimestamp();
    if (newestTimestamp === 0 || this.stateManager.getFollowingPubkeys().length === 0) {
      return;
    }

    // Start polling via FeedOrchestrator
    this.feedOrchestrator.startPolling(
      this.stateManager.getFollowingPubkeys(),
      newestTimestamp,
      (info: NewNotesInfo) => this.handleNewNotesDetected(info),
      this.stateManager.getIncludeReplies(), // Respect timeline view setting
      60000, // Start after 60 seconds
      this.stateManager.getSelectedRelay(), // Poll only from this relay (if relay-filtered)
      this.filterAuthorPubkey // Don't filter profile user's notes in ProfileView
    );
  }

  /**
   * Handle new notes detected
   */
  private handleNewNotesDetected(info: NewNotesInfo): void {
    // Silent operation - UI updates via RefreshButton
    if (this.refreshButton) {
      this.refreshButton.update(info.count, info.authorPubkeys);
    }
  }




  /**
   * Save view state (implements View base class)
   */
  public override saveState(): void {
    this.scrollPositionManager.save();
  }

  /**
   * Restore view state (implements View base class)
   */
  public override restoreState(): void {
    this.scrollPositionManager.restore();
  }

  /**
   * Get the DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Pause background tasks (implements View base class)
   */
  public override pause(): void {
    this.lifecycleManager.pause();
  }

  /**
   * Resume background tasks (implements View base class)
   */
  public override resume(): void {
    const loadTrigger = this.element.querySelector('.timeline-load-trigger') as HTMLElement;

    // Only restart polling if not already running (avoid duplicate on first mount)
    if (!this.feedOrchestrator.isPolling()) {
      this.lifecycleManager.resume(
        this.stateManager.getFollowingPubkeys(),
        this.stateManager.getNewestTimestamp(),
        (info: NewNotesInfo) => this.handleNewNotesDetected(info),
        this.stateManager.getIncludeReplies(),
        loadTrigger,
        this.stateManager.getSelectedRelay(),
        this.filterAuthorPubkey // Don't filter profile user's notes in ProfileView
      );
    } else {
      // Just reconnect infinite scroll observer
      if (loadTrigger) {
        this.infiniteScroll.observe(loadTrigger);
      }
    }

    // Update ISL with cached stats (from SNV visits)
    this.islStatsUpdater.updateFromCache(this.stateManager.getEvents());
  }


  /**
   * Cleanup resources
   */
  public destroy(): void {
    // Unsubscribe from user login events
    if (this.userLoginSubscriptionId) {
      this.eventBus.off(this.userLoginSubscriptionId);
    }

    this.lifecycleManager.destroy();
    this.element.remove();
  }
}