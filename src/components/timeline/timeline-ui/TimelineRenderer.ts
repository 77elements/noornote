/**
 * TimelineRenderer
 * Handles rendering of timeline events (notes/cards)
 *
 * No DOM ceiling: what was loaded stays in the DOM (user decision
 * 2026-11-14 — ceiling trims removed the newest cards mid-session).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { diagLog } from '../../../services/DiagnosticLogger';
import { NoteUI } from '../../ui/NoteUI';
import { TimelineStateManager } from '../timeline-state/TimelineStateManager';
import { TimelineUIStateHandler } from './TimelineUIStateHandler';
import {
  getFirstPaintCount,
  getRenderBatchSize,
} from '../../../helpers/deviceTier';

export class TimelineRenderer {
  private element: HTMLElement;
  private stateManager: TimelineStateManager;
  private uiStateHandler: TimelineUIStateHandler;
  /** Incremented per renderEvents(); pending progressive batches with an
   *  older token are stale and stop silently. */
  private renderToken = 0;
  /** Currently scheduled progressive batches (null when none pending).
   *  appendNewEvents flushes these first — a loadMore append must never
   *  land ABOVE still-unrendered newer notes (the rootMargin prefetch
   *  fires loadMore long before the user reaches the load trigger). */
  private pendingBatches: {
    events: NostrEvent[];
    cursor: number;
    token: number;
    /** Set by flushProgressiveBatches — already-scheduled steps must die. */
    cancelled?: boolean;
  } | null = null;
  /** DOM-order mirror of top-level card ids (oldest analysis aid): every DOM
   *  writer keeps this in sync; checkOrderInvariant() compares it against the
   *  state and logs structured drift evidence for log-export analysis. */
  private domOrder: Array<{ id: string; ts: number }> = [];

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
   * Compare the DOM-order mirror against the state order and the real DOM
   * card count; on drift, log structured evidence (top ids + timestamps of
   * both sides, first mismatch position) for user log exports. Cheap:
   * prefix comparison + one :scope count query.
   */
  private checkOrderInvariant(reason: string): void {
    const events = this.stateManager.getEvents();
    let firstMismatch = -1;
    for (let i = 0; i < this.domOrder.length; i++) {
      if (events[i]?.id !== this.domOrder[i]!.id) {
        firstMismatch = i;
        break;
      }
    }
    const domCount = this.element.querySelectorAll(
      ':scope > .note-card'
    ).length;
    if (firstMismatch === -1 && domCount === this.domOrder.length) return;
    diagLog('system', 'Timeline order drift detected', {
      reason,
      firstMismatch,
      domCount,
      mirrorCount: this.domOrder.length,
      stateCount: events.length,
      domTop: this.domOrder.slice(0, 10),
      stateTop: events.slice(0, 10).map(e => ({ id: e.id!, ts: e.created_at })),
    });
  }

  /** Rebuild the mirror from a render pass (full DOM replacement). */
  private resetMirror(ids: Array<{ id: string; ts: number }>): void {
    this.domOrder = ids;
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

      // Mirror + invariant: DOM starts as the first batch of `events`.
      this.resetMirror(
        events.slice(0, firstBatch).map(e => ({ id: e.id!, ts: e.created_at }))
      );
      this.checkOrderInvariant('initial-paint');

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
    const pending: {
      events: NostrEvent[];
      cursor: number;
      token: number;
      cancelled?: boolean;
    } = {
      events,
      cursor: startIndex,
      token,
    };
    this.pendingBatches = pending;
    let cursor = startIndex;
    const step = (): void => {
      if (token !== this.renderToken || pending.cancelled) return; // superseded or flushed
      const trigger = this.element.querySelector('.timeline-load-trigger');
      if (!trigger) return;
      const batchStart = cursor;
      const batchEnd = Math.min(cursor + getRenderBatchSize(), events.length);
      const fragment = document.createDocumentFragment();
      for (let i = cursor; i < batchEnd; i++) {
        fragment.appendChild(this.createNoteElement(events[i]!, i));
      }
      cursor = batchEnd;
      this.element.insertBefore(fragment, trigger);
      for (let i = batchStart; i < batchEnd; i++) {
        this.domOrder.push({
          id: events[i]!.id!,
          ts: events[i]!.created_at,
        });
      }
      this.checkOrderInvariant('progressive-batch');
      if (cursor < events.length) {
        pending.cursor = cursor;
        window.setTimeout(step, 0);
      } else {
        this.pendingBatches = null;
      }
    };
    window.setTimeout(step, 0);
  }

  /**
   * Render all still-pending progressive batches SYNCHRONOUSLY. Called by
   * appendNewEvents (loadMore) so appended older notes can never land above
   * not-yet-rendered newer ones — the rootMargin prefetch triggers loadMore
   * long before the user reaches the bottom, so this interleave is common,
   * not rare. Stale pending batches (superseded render) are dropped.
   */
  public flushProgressiveBatches(): void {
    const pending = this.pendingBatches;
    this.pendingBatches = null;
    if (!pending || pending.token !== this.renderToken) return;
    // Already-scheduled steps keep running off the closure — cancel them
    // explicitly or they would re-insert the flushed cards (duplicates).
    pending.cancelled = true;
    const trigger = this.element.querySelector('.timeline-load-trigger');
    if (!trigger || pending.cursor >= pending.events.length) return;
    const fragment = document.createDocumentFragment();
    for (let i = pending.cursor; i < pending.events.length; i++) {
      fragment.appendChild(this.createNoteElement(pending.events[i]!, i));
    }
    this.element.insertBefore(fragment, trigger);
    for (let i = pending.cursor; i < pending.events.length; i++) {
      this.domOrder.push({
        id: pending.events[i]!.id!,
        ts: pending.events[i]!.created_at,
      });
    }
    this.checkOrderInvariant('flush-before-append');
  }

  /**
   * Append new events to timeline without clearing existing DOM
   * SYNCHRONOUS - instant DOM updates, background tasks for quotes/profiles
   */
  public appendNewEvents(newEvents: NostrEvent[]): void {
    const loadTrigger = this.element.querySelector('.timeline-load-trigger');
    if (!loadTrigger) return;

    try {
      // A pending progressive batch holds NEWER notes than any loadMore
      // result — flush it first, or its cards would insert below ours.
      this.flushProgressiveBatches();

      // Render ALL notes SYNCHRONOUSLY (no await, instant!)
      const fragment = document.createDocumentFragment();

      newEvents.forEach((event, idx) => {
        const noteElement = this.createNoteElement(event, idx);
        fragment.appendChild(noteElement);
      });

      // Insert notes before load trigger
      this.element.insertBefore(fragment, loadTrigger);
      for (const event of newEvents) {
        this.domOrder.push({ id: event.id!, ts: event.created_at });
      }
      this.checkOrderInvariant('loadmore-append');
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
      this.domOrder = [
        ...newEvents.map(e => ({ id: e.id!, ts: e.created_at })),
        ...this.domOrder,
      ];
      this.checkOrderInvariant('prepend');
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
