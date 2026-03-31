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

/** Max top-level .note-card elements in the DOM before trimming */
const MAX_DOM_CARDS = getCacheSize(150, 100, 60);

export class TimelineRenderer {
  private element: HTMLElement;
  private stateManager: TimelineStateManager;
  private uiStateHandler: TimelineUIStateHandler;

  constructor(
    element: HTMLElement,
    stateManager: TimelineStateManager,
    uiStateHandler: TimelineUIStateHandler
  ) {
    this.element = element;
    this.stateManager = stateManager;
    this.uiStateHandler = uiStateHandler;
  }

  /**
   * Render all events using NoteUI components (full refresh)
   * SYNCHRONOUS - instant rendering
   */
  public renderEvents(): void {
    const loadTrigger = this.element.querySelector('.timeline-load-trigger');
    if (!loadTrigger) return;

    // Clear existing note-cards (all .note-card elements)
    this.element.querySelectorAll('.note-card').forEach(card => card.remove());

    try {
      // Render all notes SYNCHRONOUSLY
      const fragment = document.createDocumentFragment();
      const events = this.stateManager.getEvents();

      events.forEach((event, index) => {
        const noteElement = this.createNoteElement(event, index);
        fragment.appendChild(noteElement);
      });

      // Insert before load trigger
      this.element.insertBefore(fragment, loadTrigger);

      console.log(`${events.length} notes and other stuff: ready ✅`);

      // Hide empty state if we have events
      if (events.length > 0) {
        this.uiStateHandler.hideEmptyState();
      }
    } catch (error) {
      console.error('❌ Error rendering notes:', error);
      if (error instanceof Error) console.error('Stack trace:', error.stack);
      // Show error state - no fallback needed, NoteUI is single source of truth
      this.uiStateHandler.showErrorState('Failed to render timeline events');
    }
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
    // Get only top-level note-cards (not nested quotes)
    const topLevelCards = this.getTopLevelCards();
    const excess = topLevelCards.length - MAX_DOM_CARDS;
    if (excess <= 0) return;

    // Find the scroll container (.timeline-view__timeline)
    const scrollContainer = this.element.parentElement;
    if (!scrollContainer) return;

    // Measure total height of cards to remove (for scroll compensation)
    let removedHeight = 0;
    for (let i = 0; i < excess; i++) {
      const card = topLevelCards[i]!;
      removedHeight += card.getBoundingClientRect().height;

      // Cleanup NoteUI internals (ISL, headers, etc.)
      const eventId = card.getAttribute('data-event-id');
      if (eventId) {
        NoteUI.cleanup(eventId);
      }
      card.remove();
    }

    // Compensate scroll position so viewport doesn't jump
    scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - removedHeight);
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
