/**
 * PublicTimelineComponent
 * Read-only timeline for the /welcome landing page
 * Fetches notes from curated pubkeys via aggregator relays (no auth needed)
 * Inserts marketing interstitials every 15 notes (5 total)
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { NoteService } from '../../services/NoteService';
import { NoteUI } from '../ui/NoteUI';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { RefreshButton } from '../ui/RefreshButton';
import { createConfrontationInterstitial, createBoldMinimalInterstitial, createGetPaidInterstitial, createWakeUpInterstitial } from './WelcomeInterstitials';
import { STARTER_ACCOUNTS } from '../../services/orchestration/configs/StarterAccountsConfig';
import { decodeNip19 } from '../../services/NostrToolsAdapter';

/** Convert npubs to hex pubkeys at module load */
const CURATED_PUBKEYS: string[] = STARTER_ACCOUNTS.map(npub => {
  try {
    const decoded = decodeNip19(npub);
    return decoded.data as string;
  } catch {
    return '';
  }
}).filter(hex => hex.length > 0);

/** Interstitial factories in display order */
const INTERSTITIAL_FACTORIES = [
  createConfrontationInterstitial,
  createBoldMinimalInterstitial,
  createGetPaidInterstitial,
  createWakeUpInterstitial,
];
const INTERSTITIAL_INTERVAL = 15;
const MAX_INTERSTITIALS = INTERSTITIAL_FACTORIES.length;
const POLLING_INTERVAL = 60_000; // 60 seconds

export class PublicTimelineComponent {
  private container: HTMLElement;
  private noteContainer: HTMLElement;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private noteService: NoteService;
  private infiniteScroll: InfiniteScroll;
  private events: NostrEvent[] = [];
  private totalRenderedNotes = 0;
  private interstitialsShown = 0;
  private isLoading = false;
  private oldestTimestamp = 0;
  private newestTimestamp = 0;
  private pollingIntervalId: number | null = null;
  private polledEvents: NostrEvent[] = [];
  private refreshButton: RefreshButton | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.noteService = NoteService.getInstance();

    // Create note container inside the provided container
    this.noteContainer = document.createElement('div');
    this.noteContainer.className = 'public-timeline__notes';
    this.container.appendChild(this.noteContainer);

    this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
      loadingMessage: 'Loading more notes...'
    });

    this.infiniteScroll.observe(this.noteContainer);
    this.loadInitial();
  }

  /**
   * Load initial batch of notes
   */
  private async loadInitial(): Promise<void> {
    if (CURATED_PUBKEYS.length === 0) {
      this.noteContainer.innerHTML = '<p class="public-timeline__empty">Timeline coming soon.</p>';
      return;
    }

    this.isLoading = true;
    this.infiniteScroll.showLoading();

    try {
      const relays = this.relayConfig.getAggregatorRelays();
      const filters: NDKFilter[] = [{
        authors: CURATED_PUBKEYS,
        kinds: [1],
        limit: 30
      }];

      const events = await this.transport.fetch(relays, filters, 8000, false, 'PublicTimeline');
      const filtered = this.filterAndSort(events);

      if (filtered.length > 0) {
        this.events = filtered;
        this.noteService.registerNotes(filtered);
        this.newestTimestamp = filtered[0]!.created_at;
        this.oldestTimestamp = filtered[filtered.length - 1]!.created_at;
        this.renderNotes(filtered);
        this.startPolling();
      } else {
        this.noteContainer.innerHTML = '<p class="public-timeline__empty">No notes found yet.</p>';
      }
    } catch (error) {
      console.error('[PublicTimeline] Initial load failed:', error);
    } finally {
      this.isLoading = false;
      this.infiniteScroll.hideLoading();
      this.infiniteScroll.refresh();
    }
  }

  /**
   * Handle infinite scroll load more
   */
  private async handleLoadMore(): Promise<void> {
    if (this.isLoading || CURATED_PUBKEYS.length === 0) return;

    this.isLoading = true;
    this.infiniteScroll.pause();
    this.infiniteScroll.showLoading();

    try {
      const relays = this.relayConfig.getAggregatorRelays();
      const timeWindowSeconds = 3 * 3600; // 3h chunks
      const filters: NDKFilter[] = [{
        authors: CURATED_PUBKEYS,
        kinds: [1],
        until: this.oldestTimestamp - 1,
        since: this.oldestTimestamp - timeWindowSeconds,
        limit: 30
      }];

      const events = await this.transport.fetch(relays, filters, 8000, false, 'PublicTimeline');
      const filtered = this.filterAndSort(events);
      const newEvents = this.deduplicateAgainstExisting(filtered);

      if (newEvents.length > 0) {
        this.events.push(...newEvents);
        this.noteService.registerNotes(newEvents);
        this.oldestTimestamp = newEvents[newEvents.length - 1]!.created_at;
        this.renderNotes(newEvents);
      } else {
        // If no events found, push the window further back
        this.oldestTimestamp -= timeWindowSeconds;
      }
    } catch (error) {
      console.error('[PublicTimeline] Load more failed:', error);
    } finally {
      this.isLoading = false;
      this.infiniteScroll.hideLoading();
      this.infiniteScroll.resume();
      this.infiniteScroll.refresh();
    }
  }

  /**
   * Render notes into the container, inserting interstitials every 15 notes
   */
  private renderNotes(events: NostrEvent[]): void {
    const sentinel = this.noteContainer.querySelector('.infinite-scroll-sentinel');

    for (const event of events) {
      const noteEl = NoteUI.createNoteElement(event, {
        collapsible: true,
        islFetchStats: false,
        isLoggedIn: false,
        headerSize: 'medium',
        depth: 0
      });

      if (sentinel) {
        this.noteContainer.insertBefore(noteEl, sentinel);
      } else {
        this.noteContainer.appendChild(noteEl);
      }

      this.totalRenderedNotes++;

      // Insert interstitial at every 15-note boundary
      if (this.interstitialsShown < MAX_INTERSTITIALS &&
          this.totalRenderedNotes % INTERSTITIAL_INTERVAL === 0) {
        const interstitial = INTERSTITIAL_FACTORIES[this.interstitialsShown]!();
        if (sentinel) {
          this.noteContainer.insertBefore(interstitial, sentinel);
        } else {
          this.noteContainer.appendChild(interstitial);
        }
        this.interstitialsShown++;
      }
    }
  }

  /**
   * Filter replies and sort by timestamp (newest first)
   */
  private filterAndSort(events: NostrEvent[]): NostrEvent[] {
    // Deduplicate
    const unique = Array.from(new Map(events.map(e => [e.id, e])).values());

    // Filter out replies (notes with 'e' tags)
    const filtered = unique.filter(event => {
      if (event.kind !== 1) return false;
      const eTags = event.tags.filter(tag => tag[0] === 'e');
      return eTags.length === 0;
    });

    // Sort newest first
    filtered.sort((a, b) => b.created_at - a.created_at);
    return filtered;
  }

  /**
   * Remove events we already have
   */
  private deduplicateAgainstExisting(newEvents: NostrEvent[]): NostrEvent[] {
    const existingIds = new Set(this.events.map(e => e.id));
    return newEvents.filter(e => !existingIds.has(e.id));
  }

  /**
   * Start polling for new notes every 60 seconds
   */
  private startPolling(): void {
    this.pollingIntervalId = window.setInterval(() => this.poll(), POLLING_INTERVAL);
  }

  /**
   * Poll relays for notes newer than the most recent one
   */
  private async poll(): Promise<void> {
    if (this.isLoading || CURATED_PUBKEYS.length === 0) return;

    try {
      const relays = this.relayConfig.getAggregatorRelays();
      const filters: NDKFilter[] = [{
        authors: CURATED_PUBKEYS,
        kinds: [1],
        since: this.newestTimestamp + 1,
        limit: 50
      }];

      const events = await this.transport.fetch(relays, filters, 5000, false, 'PublicTimeline');
      const filtered = this.filterAndSort(events);
      const newEvents = this.deduplicateAgainstExisting(filtered);

      if (newEvents.length === 0) return;

      // Cache polled events (accumulate across polls)
      const existingPolledIds = new Set(this.polledEvents.map(e => e.id));
      for (const event of newEvents) {
        if (!existingPolledIds.has(event.id)) {
          this.polledEvents.push(event);
        }
      }

      // Extract unique author pubkeys (max 4, newest first)
      const seen = new Set<string>();
      const authorPubkeys: string[] = [];
      for (const event of this.polledEvents) {
        if (!seen.has(event.pubkey)) {
          seen.add(event.pubkey);
          authorPubkeys.push(event.pubkey);
          if (authorPubkeys.length >= 4) break;
        }
      }

      // Show or update refresh button
      if (!this.refreshButton) {
        this.refreshButton = new RefreshButton({
          newNotesCount: this.polledEvents.length,
          authorPubkeys,
          onClick: () => this.handleRefreshClick()
        });
        const refreshSlot = this.container.closest('.public-timeline')?.querySelector('.public-timeline__refresh-slot');
        if (refreshSlot) {
          refreshSlot.appendChild(this.refreshButton.getElement());
        } else {
          this.noteContainer.prepend(this.refreshButton.getElement());
        }
      } else {
        this.refreshButton.update(this.polledEvents.length, authorPubkeys);
      }
    } catch (error) {
      console.error('[PublicTimeline] Poll failed:', error);
    }
  }

  /**
   * Handle refresh button click - prepend cached new notes
   */
  private handleRefreshClick(): void {
    if (this.polledEvents.length === 0) return;

    // Sort newest first
    this.polledEvents.sort((a, b) => b.created_at - a.created_at);

    // Update timestamps and state
    this.newestTimestamp = this.polledEvents[0]!.created_at;
    this.events.unshift(...this.polledEvents);
    this.noteService.registerNotes(this.polledEvents);

    // Prepend to DOM using fragment (same pattern as TimelineRenderer)
    const fragment = document.createDocumentFragment();
    for (const event of this.polledEvents) {
      fragment.appendChild(NoteUI.createNoteElement(event, {
        collapsible: true,
        islFetchStats: false,
        isLoggedIn: false,
        headerSize: 'medium',
        depth: 0
      }));
    }
    this.noteContainer.insertBefore(fragment, this.noteContainer.firstChild);

    // Clear cached events and hide button
    this.polledEvents = [];
    if (this.refreshButton) {
      this.refreshButton.hide();
    }
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
    this.infiniteScroll.destroy();
    NoteUI.cleanupAll();
  }
}
