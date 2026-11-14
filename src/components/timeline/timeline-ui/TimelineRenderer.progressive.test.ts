// @vitest-environment jsdom
/**
 * Progressive first paint in TimelineRenderer.renderEvents.
 *
 * Regression guard for the weak-phone startup fix: the initial timeline
 * render must paint a small first batch synchronously and stream the rest
 * in non-blocking batches — instead of building up to 50 note cards in one
 * synchronous main-thread burst. A re-render while batches are pending must
 * invalidate them (token check), so no stale card lands in fresh DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getFirstPaintCount, getRenderBatchSize } = vi.hoisted(() => ({
  getFirstPaintCount: vi.fn(() => 3),
  getRenderBatchSize: vi.fn(() => 2),
}));

vi.mock('../../../helpers/deviceTier', () => ({
  getFirstPaintCount,
  getRenderBatchSize,
}));

vi.mock('../../ui/NoteUI', () => ({
  NoteUI: {
    createNoteElement: (event: { id: string }, index: number) => {
      const div = document.createElement('div');
      div.className = 'note-card';
      div.dataset.eventId = event.id;
      div.dataset.index = String(index);
      return div;
    },
    cleanupElement: vi.fn(),
  },
}));

import { TimelineRenderer } from './TimelineRenderer';
import { TimelineStateManager } from '../timeline-state/TimelineStateManager';
import { TimelineUIStateHandler } from './TimelineUIStateHandler';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

function makeEvent(id: string): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    content: `note ${id.slice(0, 4)}`,
    tags: [],
    kind: 1,
    created_at: 1_700_000_000,
    sig: 'x'.repeat(128),
  };
}

function makeRenderer(events: NostrEvent[]): {
  renderer: TimelineRenderer;
  element: HTMLElement;
} {
  const element = document.createElement('div');
  const trigger = document.createElement('div');
  trigger.className = 'timeline-load-trigger';
  element.appendChild(trigger);

  const stateManager = {
    getEvents: () => events,
  } as unknown as TimelineStateManager;
  const uiStateHandler = {
    hideEmptyState: vi.fn(),
    showErrorState: vi.fn(),
  } as unknown as TimelineUIStateHandler;

  const renderer = new TimelineRenderer(
    element,
    stateManager,
    uiStateHandler,
    true
  );
  return { renderer, element };
}

function renderedIds(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll('.note-card')).map(
    card => (card as HTMLElement).dataset.eventId ?? ''
  );
}

describe('TimelineRenderer.renderEvents — progressive first paint', () => {
  beforeEach(() => {
    getFirstPaintCount.mockImplementation(() => 3);
    getRenderBatchSize.mockImplementation(() => 2);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the first batch synchronously and streams the rest in batches', () => {
    const events = Array.from({ length: 7 }, (_, i) =>
      makeEvent(`${i + 1}`.padEnd(64, '0'))
    );
    const { renderer, element } = makeRenderer(events);

    renderer.renderEvents();

    // First paint: exactly the first 3 cards, in order, synchronously.
    expect(renderedIds(element)).toHaveLength(3);
    expect(renderedIds(element)[0]).toBe('1'.padEnd(64, '0'));

    // Two batches of 2 (7 - 3 = 4 remaining → 2 + 2).
    vi.runAllTimers();
    const ids = renderedIds(element);
    expect(ids).toHaveLength(7);
    expect(ids).toEqual(events.map(e => e.id)); // order preserved
  });

  it('renders everything synchronously when events fit into the first batch', () => {
    const events = [makeEvent('a'.repeat(64)), makeEvent('b'.repeat(64))];
    const { renderer, element } = makeRenderer(events);

    renderer.renderEvents();
    expect(renderedIds(element)).toHaveLength(2);
    vi.runAllTimers();
    expect(renderedIds(element)).toHaveLength(2); // no extra batches scheduled
  });

  it('invalidates pending batches when a new render replaces the DOM', () => {
    const events = Array.from({ length: 7 }, (_, i) =>
      makeEvent(`${i + 1}`.padEnd(64, '0'))
    );
    const { renderer, element } = makeRenderer(events);

    renderer.renderEvents();
    expect(renderedIds(element)).toHaveLength(3);

    // Re-render with a shorter list BEFORE the pending batches run.
    const fewer = events.slice(0, 4);
    (
      renderer as unknown as { stateManager: { getEvents: () => NostrEvent[] } }
    ).stateManager.getEvents = () => fewer;
    renderer.renderEvents();

    vi.runAllTimers();
    // No stale card from the first render's pending batches may land.
    const ids = renderedIds(element);
    expect(ids).toHaveLength(4);
    expect(ids.every(id => fewer.some(e => e.id === id))).toBe(true);
  });

  it('flushes pending batches before an append — loadMore notes never land above newer ones', () => {
    // Real-world regression: the rootMargin prefetch fires loadMore while
    // progressive batches are still pending. Pending batches hold NEWER
    // notes than the loadMore result — without the flush they inserted
    // BELOW the appended older notes (visible as a 3-minute-old note
    // sitting under a 32-minute-old one).
    const events = Array.from(
      { length: 7 },
      (_, i) => makeEvent(`${i + 1}`.padEnd(64, '0')) // ids 1..7, newest first
    );
    const { renderer, element } = makeRenderer(events);

    renderer.renderEvents();
    expect(renderedIds(element)).toHaveLength(3); // ids 1..3

    // loadMore appends OLDER notes while batches for 4..7 are still pending.
    const older = [
      makeEvent('8'.padEnd(64, '0')),
      makeEvent('9'.padEnd(64, '0')),
    ];
    renderer.appendNewEvents(older);

    vi.runAllTimers();
    // 4..7 must render ABOVE 8..9 — i.e. the flush completed the pending
    // batches before the append, and no stale batch fires afterwards.
    const ids = renderedIds(element);
    expect(ids).toHaveLength(9);
    expect(ids).toEqual([
      ...events.map(e => e.id),
      '8'.padEnd(64, '0'),
      '9'.padEnd(64, '0'),
    ]);
  });
});
