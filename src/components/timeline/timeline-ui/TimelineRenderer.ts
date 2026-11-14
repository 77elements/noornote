/**
 * TimelineRenderer
 * Handles rendering of timeline events (notes/cards)
 *
 * DOM Ceiling: Limits the number of top-level .note-card elements in the DOM.
 * When appending new cards at the bottom, excess cards are removed from the top
 * (with scroll position compensation). Events stay in StateManager for dedup/pagination.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NoteUI } from '../../ui/NoteUI';
import { TimelineStateManager } from '../timeline-state/TimelineStateManager';
import { TimelineUIStateHandler } from './TimelineUIStateHandler';
import { getCacheSize } from '../../../helpers/LRUCache';
import {
  getFirstPaintCount,
  getRenderBatchSize,
} from '../../../helpers/deviceTier';

/** Max top-level .note-card elements in the DOM before trimming */
const MAX_DOM_CARDS = getCacheSize(150, 100, 60);

export class TimelineRenderer {
  private element: HTMLElement;
  private stateManager: TimelineStateManager;
  private uiStateHandler: TimelineUIStateHandler;
  /**
   * ProfileView must always show the COMPLETE author timeline (no matter how the
   * user enters it, and so a back-from-note lands exactly where they left off).
   * Trimming the DOM/state would drop the newest cards once the user scrolls
   * deep, so it is disabled for ProfileView. The main Timeline keeps trimming.
   */
  private readonly disableTrim: boolean;
  /** Incremented per renderEvents(); pending progressive batches with an
   *  older token are stale and stop silently. */
  private renderToken = 0;

  constructor(
    element: HTMLElement,
    stateManager: TimelineStateManager,
    uiStateHandler: TimelineUIStateHandler,
    disableTrim: boolean = false
  ) {
    this.element = element;
    this.stateManager = stateManager;
    this.uiStateHandler = uiStateHandler;
    this.disableTrim = disableTrim;
  }

  /**
   * Render all events using NoteUI components (full refresh).
   *
   * Progressive first paint: only the first batch renders synchronously, the
   * rest follows in small chunks between frames. On weak phones a 50-card
   * synchronous burst blocked the main thread for the whole build — the user
   * stared at the skeleton/blank pane while the page was technically "done
   * loading". Batching keeps the paint fast and the remaining cards stream
   * in without blocking input. A monotonically increasing token invalidates
   * pending batches when a new renderEvents() replaces the DOM.
   */
  public renderEvents(): void {
    const loadTrigger = this.element.querySelector('.timeline-load-trigger');
    if (!loadTrigger) return;

    // Clear existing note-cards — cleanup NoteUI internals before removing from DOM
    this.element.querySelectorAll<HTMLElement>('.note-card').forEach(card => {
      NoteUI.cleanupElement(card);
      card.remove();
    });

    // Invalidate any progressive batches from a previous render.
    this.renderToken++;

    try {
      const events = this.stateManager.getEvents();

      // First batch: synchronous, sized for the device tier.
      const firstBatch = Math.min(events.length, getFirstPaintCount());
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < firstBatch; i++) {
        fragment.appendChild(this.createNoteElement(events[i]!, i));
      }
      this.element.insertBefore(fragment, loadTrigger);

      // Hide empty state if we have events
      if (events.length > 0) {
        this.uiStateHandler.hideEmptyState();
      }

      this.scheduleProgressiveBatches(events, firstBatch);
    } catch (error) {
      console.error('❌ Error rendering notes:', error);
      if (error instanceof Error) console.error('Stack trace:', error.stack);
      // Show error state - no fallback needed, NoteUI is single source of truth
      this.uiStateHandler.showErrorState('Failed to render timeline events');
    }
  }

  /**
   * Render the remaining events in small batches between frames. Each batch
   * re-queries the load trigger (a re-render may have replaced the DOM in
   * between; the token check makes stale batches no-ops).
   */
  private scheduleProgressiveBatches(
    events: NostrEvent[],
    startIndex: number
  ): void {
    if (startIndex >= events.length) return;
    const token = this.renderToken;
    let cursor = startIndex;
    const step = (): void => {
      if (token !== this.renderToken) return; // superseded by a newer render
      const trigger = this.element.querySelector('.timeline-load-trigger');
      if (!trigger) return;
      const batchEnd = Math.min(cursor + getRenderBatchSize(), events.length);
      const fragment = document.createDocumentFragment();
      for (let i = cursor; i < batchEnd; i++) {
        fragment.appendChild(this.createNoteElement(events[i]!, i));
      }
      cursor = batchEnd;
      this.element.insertBefore(fragment, trigger);
      if (cursor < events.length) {
        window.setTimeout(step, 0);
      }
    };
    window.setTimeout(step, 0);
  }

  /**
   * Append new events to timeline without clearing existing DOM
   * SYNCHRONOUS - instant DOM updates, background tasks for quotes/profiles
   */
  public appendNewEvents(newEvents: NostrEvent[]): void {
    const loadTrigger = this.element.querySelector('.timeline-load-trigger');
    if (!loadTrigger) return;

    try {
      // Render ALL notes SYNCHRONOUSLY (no await, instant!)
      const fragment = document.createDocumentFragment();

      newEvents.forEach((event, idx) => {
        const noteElement = this.createNoteElement(event, idx);
        fragment.appendChild(noteElement);
      });

      // Insert notes before load trigger
      this.element.insertBefore(fragment, loadTrigger);

      // Trim excess cards from the top of the timeline
      this.trimExcessCards();
    } catch (error) {
      console.error(`❌ APPEND FAILED:`, error);
    }
  }

  /**
   * Prepend new events to top of timeline without clearing existing DOM
   * SYNCHRONOUS - instant DOM updates
   */
  public prependNewEvents(newEvents: NostrEvent[]): void {
    const header = this.element.querySelector('.timeline-header');
    if (!header || !header.nextSibling) return;

    try {
      // Render ALL notes SYNCHRONOUSLY
      const fragment = document.createDocumentFragment();

      newEvents.forEach((event, idx) => {
        const noteElement = this.createNoteElement(event, idx);
        fragment.appendChild(noteElement);
      });

      // Insert right after timeline-header (at the top of notes)
      this.element.insertBefore(fragment, header.nextSibling);
    } catch (error) {
      console.error(`❌ PREPEND FAILED:`, error);
    }
  }

  /**
   * Remove top-level .note-card elements from the top when DOM exceeds MAX_DOM_CARDS.
   * Compensates scroll position so the user doesn't see a jump.
   */
  private trimExcessCards(): void {
    // ProfileView keeps the full timeline (see disableTrim) — never trim.
    if (this.disableTrim) return;

    // Get only top-level note-cards (not nested quotes)
    const topLevelCards = this.getTopLevelCards();
    const excess = topLevelCards.length - MAX_DOM_CARDS;
    if (excess <= 0) return;

    // Find the scroll container (.timeline-view__timeline)
    const scrollContainer = this.element.parentElement;
    if (!scrollContainer) return;

    // Snapshot scroll BEFORE removing so we can keep the viewport anchored.
    // The removed cards sit above the viewport, so the content below shifts up by
    // exactly the amount the container shrinks — shift scrollTop up by the same.
    const prevScrollTop = scrollContainer.scrollTop;
    const prevScrollHeight = scrollContainer.scrollHeight;

    for (let i = 0; i < excess; i++) {
      const card = topLevelCards[i]!;
      // Cleanup NoteUI internals (ISL, headers, etc.)
      NoteUI.cleanupElement(card);
      card.remove();
    }

    // Reading scrollHeight forces a synchronous reflow, so this delta reflects
    // the actual removed height (reflow-accurate — unlike summing each card's
    // getBoundingClientRect, which is wrong while images are still loading).
    // overflow-anchor:none on the container stops the browser from also adjusting
    // scrollTop, which would double-correct and yank the viewport to the top.
    const removedHeight = prevScrollHeight - scrollContainer.scrollHeight;
    scrollContainer.scrollTop = Math.max(0, prevScrollTop - removedHeight);

    // Trim StateManager events to match DOM ceiling (prevent unbounded growth)
    this.stateManager.trimEvents(MAX_DOM_CARDS);
  }

  /**
   * Get top-level .note-card elements (excludes nested quotes/embeds)
   */
  private getTopLevelCards(): HTMLElement[] {
    const allCards = this.element.querySelectorAll(':scope > .note-card');
    return Array.from(allCards) as HTMLElement[];
  }

  /**
   * Create element for nostr event
   * SYNCHRONOUS - instant DOM creation
   */
  private createNoteElement(event: NostrEvent, index: number): HTMLElement {
    // Timeline notes are always top-level (depth = 0)
    return NoteUI.createNoteElement(event, index, 0);
  }
}
