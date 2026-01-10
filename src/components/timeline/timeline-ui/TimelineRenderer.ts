/**
 * TimelineRenderer
 * Handles rendering of timeline events (notes/cards)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NoteUI } from '../../ui/NoteUI';
import { TimelineStateManager } from '../timeline-state/TimelineStateManager';
import { TimelineUIStateHandler } from './TimelineUIStateHandler';

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
   * Create element for nostr event
   * SYNCHRONOUS - instant DOM creation
   */
  private createNoteElement(event: NostrEvent, index: number): HTMLElement {
    // Timeline notes are always top-level (depth = 0)
    return NoteUI.createNoteElement(event, index, 0);
  }
}
