/**
 * TimelineLifecycleManager - Manages timeline lifecycle
 * Handles pause/resume/destroy operations for background tasks
 * Extracts from: TimelineUI.pause(), resume(), destroy()
 */

import type {
  TimelineModuleApi,
  NewNotesInfo,
} from '../../../modules/timeline/contracts';
import { InfiniteScroll } from '../../ui/InfiniteScroll';
import { RefreshButton } from '../../ui/RefreshButton';
import { CustomDropdown } from '../../ui/CustomDropdown';
import { NoteHeader } from '../../ui/NoteHeader';

export class TimelineLifecycleManager {
  private timelineApi: TimelineModuleApi;
  private infiniteScroll: InfiniteScroll;
  private refreshButton: RefreshButton | null = null;
  private viewDropdown: CustomDropdown | null = null;
  private noteHeaders: Map<string, NoteHeader> = new Map();

  constructor(timelineApi: TimelineModuleApi, infiniteScroll: InfiniteScroll) {
    this.timelineApi = timelineApi;
    this.infiniteScroll = infiniteScroll;
  }

  /**
   * Set refresh button instance
   */
  setRefreshButton(button: RefreshButton): void {
    this.refreshButton = button;
  }

  /**
   * Set view dropdown instance
   */
  setViewDropdown(dropdown: CustomDropdown): void {
    this.viewDropdown = dropdown;
  }

  /**
   * Add note header for cleanup tracking
   */
  addNoteHeader(noteId: string, header: NoteHeader): void {
    this.noteHeaders.set(noteId, header);
  }

  /**
   * Pause background tasks (polling, subscriptions) when navigating away
   */
  pause(): void {
    this.timelineApi.stopPolling();
    this.infiniteScroll.disconnect();
  }

  /**
   * Resume background tasks when returning to timeline
   */
  resume(
    followingPubkeys: string[],
    newestTimestamp: number,
    onNewNotes: (info: NewNotesInfo) => void,
    includeReplies: boolean,
    loadTrigger: HTMLElement | null,
    selectedRelay: string | null = null,
    exemptFromMuteFilter?: string,
    applyWordFilter: boolean = true
  ): void {
    // Restart polling if we have events
    if (newestTimestamp > 0) {
      this.timelineApi.startPolling(
        followingPubkeys,
        newestTimestamp,
        onNewNotes,
        includeReplies,
        60000,
        selectedRelay,
        exemptFromMuteFilter,
        applyWordFilter
      );
    }

    // Restart infinite scroll observer. Root = the actual scroll container so the
    // rootMargin prefetch fires a few posts before the end (not only at the last).
    if (loadTrigger) {
      this.infiniteScroll.observe(
        loadTrigger,
        loadTrigger.closest('.timeline-view__timeline')
      );
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    // Stop polling
    this.timelineApi.stopPolling();

    // Disconnect infinite scroll
    this.infiniteScroll.disconnect();

    // Cleanup all note headers
    this.noteHeaders.forEach(noteHeader => {
      noteHeader.destroy();
    });
    this.noteHeaders.clear();

    // Cleanup refresh button
    if (this.refreshButton) {
      this.refreshButton.destroy();
      this.refreshButton = null;
    }

    // Cleanup view dropdown
    if (this.viewDropdown) {
      this.viewDropdown.destroy();
      this.viewDropdown = null;
    }
  }
}
