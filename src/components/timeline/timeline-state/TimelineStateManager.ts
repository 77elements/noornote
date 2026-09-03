/**
 * TimelineStateManager - Manages timeline state
 * Handles events array, loading flags, following list, and filters
 * Extracts from: TimelineUI state properties and event management
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export class TimelineStateManager {
  private events: NostrEvent[] = [];
  /** Parallel id index for O(1) dedup — kept in sync with `events`. */
  private eventIds = new Set<string>();
  private loading = false;
  private hasMore = true;
  private followingPubkeys: string[] = [];

  /**
   * Get all events
   */
  getEvents(): NostrEvent[] {
    return this.events;
  }

  /**
   * Set events (replaces entire array)
   */
  setEvents(events: NostrEvent[]): void {
    this.events = events;
    this.rebuildIdIndex();
  }

  /**
   * Add events to timeline with deduplication. O(N+M) sorted merge — the
   * incoming batch is sorted, then merged into the (already descending)
   * existing array instead of a full re-sort per page.
   */
  addEvents(newEvents: NostrEvent[]): NostrEvent[] {
    return this.mergeSortedDesc(newEvents);
  }

  /**
   * Prepend events to beginning of timeline with deduplication.
   * Same O(N+M) merge as addEvents (order of the result is identical —
   * the array is always kept descending by created_at).
   */
  prependEvents(newEvents: NostrEvent[]): NostrEvent[] {
    return this.mergeSortedDesc(newEvents);
  }

  /**
   * Add single event to beginning of timeline — O(log N) binary search for
   * the insertion point instead of a full O(N log N) re-sort.
   */
  addEvent(event: NostrEvent): boolean {
    if (!event.id || this.eventIds.has(event.id)) {
      return false;
    }

    const idx = this.findInsertIndex(event.created_at);
    this.events.splice(idx, 0, event);
    this.eventIds.add(event.id);
    return true;
  }

  /**
   * Remove event by ID
   */
  removeEvent(eventId: string): boolean {
    const initialLength = this.events.length;
    this.events = this.events.filter(event => event.id !== eventId);
    if (this.events.length < initialLength && eventId) {
      this.eventIds.delete(eventId);
    }
    return this.events.length < initialLength;
  }

  /**
   * Trim events array to maxSize. Removes from the FRONT of the array —
   * the newest events — matching the renderer's DOM trim from the top
   * (viewport stays anchored while scrolled deep into older content).
   */
  trimEvents(maxSize: number): void {
    if (this.events.length > maxSize) {
      const removed = this.events.splice(0, this.events.length - maxSize);
      for (const event of removed) {
        if (event.id) this.eventIds.delete(event.id);
      }
    }
  }

  /**
   * Clear all events
   */
  clearEvents(): void {
    this.events = [];
    this.eventIds.clear();
  }

  /**
   * Get newest event timestamp
   */
  getNewestTimestamp(): number {
    // events is always sorted descending (newest first)
    return this.events[0]?.created_at ?? 0;
  }

  /**
   * Get oldest event
   */
  getOldestEvent(): NostrEvent | null {
    if (this.events.length === 0) return null;
    return this.events[this.events.length - 1] ?? null;
  }

  /**
   * Loading state
   */
  isLoading(): boolean {
    return this.loading;
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
  }

  /**
   * Has more state
   */
  getHasMore(): boolean {
    return this.hasMore;
  }

  setHasMore(hasMore: boolean): void {
    this.hasMore = hasMore;
  }

  /**
   * Following pubkeys
   */
  getFollowingPubkeys(): string[] {
    return this.followingPubkeys;
  }

  setFollowingPubkeys(pubkeys: string[]): void {
    this.followingPubkeys = pubkeys;
  }

  /**
   * Reset all state (for refresh). Filter preferences (replies, relay, time
   * range) live in the TimelineConfig now, not here.
   */
  reset(): void {
    this.events = [];
    this.eventIds.clear();
    this.hasMore = true;
    // Keep loading, followingPubkeys as they are
  }

  /**
   * Clear all state (for user switch)
   * Resets everything including following list
   */
  clear(): void {
    this.events = [];
    this.eventIds.clear();
    this.loading = false;
    this.hasMore = true;
    this.followingPubkeys = [];
  }

  // ── Internals ────────────────────────────────────────────────

  private rebuildIdIndex(): void {
    this.eventIds.clear();
    for (const event of this.events) {
      if (event.id) this.eventIds.add(event.id);
    }
  }

  /** First index whose created_at is <= the given timestamp (descending). */
  private findInsertIndex(createdAt: number): number {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.events[mid]!.created_at ?? 0) > createdAt) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Dedupe incoming against the id Set, sort the new batch descending, then
   * merge the two sorted arrays in O(N+M) (existing wins on ties — matches
   * the previous unshift+stable-sort behavior closely enough that only
   * same-second boundary ties could order differently).
   */
  private mergeSortedDesc(incoming: NostrEvent[]): NostrEvent[] {
    const unique = incoming.filter(
      newEvent => newEvent.id && !this.eventIds.has(newEvent.id)
    );
    if (unique.length === 0) return [];

    unique.sort((a, b) => b.created_at - a.created_at);

    const merged: NostrEvent[] = [];
    let i = 0;
    let j = 0;
    while (i < this.events.length && j < unique.length) {
      const existing = this.events[i]!;
      const fresh = unique[j]!;
      if ((existing.created_at ?? 0) >= (fresh.created_at ?? 0)) {
        merged.push(existing);
        i++;
      } else {
        merged.push(fresh);
        this.eventIds.add(fresh.id!);
        j++;
      }
    }
    while (i < this.events.length) {
      merged.push(this.events[i]!);
      i++;
    }
    while (j < unique.length) {
      merged.push(unique[j]!);
      this.eventIds.add(unique[j]!.id!);
      j++;
    }

    this.events = merged;
    return unique;
  }
}
