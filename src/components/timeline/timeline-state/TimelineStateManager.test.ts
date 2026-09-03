import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { TimelineStateManager } from './TimelineStateManager';

function makeEvent(id: string, createdAt: number): NostrEvent {
  return {
    id,
    kind: 1,
    pubkey: 'pk',
    created_at: createdAt,
    content: `note ${id}`,
    tags: [],
  } as unknown as NostrEvent;
}

describe('TimelineStateManager', () => {
  it('addEvents dedupes against existing events and keeps descending order', () => {
    const sm = new TimelineStateManager();
    sm.setEvents([makeEvent('a', 300), makeEvent('b', 100)]);

    const added = sm.addEvents([
      makeEvent('c', 400),
      makeEvent('a', 300), // duplicate
      makeEvent('d', 200),
    ]);

    expect(added.map(e => e.id)).toEqual(['c', 'd']);
    expect(sm.getEvents().map(e => e.id)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('prependEvents dedupes and merges identically (array stays descending)', () => {
    const sm = new TimelineStateManager();
    sm.setEvents([makeEvent('a', 300)]);

    const added = sm.prependEvents([
      makeEvent('z', 500),
      makeEvent('a', 300),
      makeEvent('m', 350),
    ]);

    expect(added.map(e => e.id)).toEqual(['z', 'm']);
    expect(sm.getEvents().map(e => e.id)).toEqual(['z', 'm', 'a']);
  });

  it('addEvent inserts at the binary-searched position, no duplicates', () => {
    const sm = new TimelineStateManager();
    sm.setEvents([makeEvent('a', 300), makeEvent('b', 100)]);

    expect(sm.addEvent(makeEvent('m', 350))).toBe(true);
    expect(sm.addEvent(makeEvent('a', 300))).toBe(false); // duplicate

    expect(sm.getEvents().map(e => e.id)).toEqual(['m', 'a', 'b']);
    expect(sm.getNewestTimestamp()).toBe(350);
  });

  it('addEvent inserts before same-timestamp events (unshift parity)', () => {
    const sm = new TimelineStateManager();
    sm.setEvents([makeEvent('a', 300), makeEvent('b', 300)]);

    sm.addEvent(makeEvent('new', 300));

    expect(sm.getEvents().map(e => e.id)).toEqual(['new', 'a', 'b']);
  });

  it('removeEvent drops the event and keeps the id index in sync', () => {
    const sm = new TimelineStateManager();
    sm.setEvents([makeEvent('a', 300), makeEvent('b', 100)]);

    expect(sm.removeEvent('a')).toBe(true);
    expect(sm.getEvents().map(e => e.id)).toEqual(['b']);

    // Re-adding the removed id must succeed (index was synced)
    expect(sm.addEvent(makeEvent('a', 300))).toBe(true);
    expect(sm.getEvents().map(e => e.id)).toEqual(['a', 'b']);
  });

  it('trimEvents removes from the front (newest, matching the DOM trim) and keeps the index in sync', () => {
    const sm = new TimelineStateManager();
    sm.setEvents([
      makeEvent('newest', 300),
      makeEvent('mid', 200),
      makeEvent('oldest', 100),
    ]);

    sm.trimEvents(2);

    expect(sm.getEvents().map(e => e.id)).toEqual(['mid', 'oldest']);
    // Removed 'newest' can be re-added (index was synced)
    expect(sm.addEvent(makeEvent('newest', 300))).toBe(true);
  });

  it('clearEvents / clear / reset drop everything and allow re-adding', () => {
    const sm = new TimelineStateManager();
    sm.setEvents([makeEvent('a', 300)]);
    sm.clearEvents();
    expect(sm.getEvents()).toEqual([]);
    expect(sm.addEvent(makeEvent('a', 300))).toBe(true);

    sm.reset();
    expect(sm.getEvents()).toEqual([]);
    expect(sm.getHasMore()).toBe(true);
    expect(sm.addEvent(makeEvent('a', 300))).toBe(true);

    sm.setFollowingPubkeys(['pk']);
    sm.clear();
    expect(sm.getEvents()).toEqual([]);
    expect(sm.getFollowingPubkeys()).toEqual([]);
    expect(sm.addEvent(makeEvent('a', 300))).toBe(true);
  });

  it('getOldestEvent returns the last (oldest) event', () => {
    const sm = new TimelineStateManager();
    sm.setEvents([makeEvent('a', 300), makeEvent('b', 100)]);
    expect(sm.getOldestEvent()?.id).toBe('b');
  });
});
