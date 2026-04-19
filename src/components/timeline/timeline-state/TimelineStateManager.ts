/**
 * TimelineStateManager - Manages timeline state
 * Handles events array, loading flags, following list, and filters
 * Extracts from: TimelineUI state properties and event management
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export class TimelineStateManager {
  private events: NostrEvent[] = [];
  private loading = false;
  private hasMore = true;
  private followingPubkeys: string[] = [];
  private includeReplies = false;
  private selectedRelay: string | null = null; // null = all relays, string = specific relay URL
  private dateRange: { since: number; until: number } | null = null; // null = live mode, set = time range mode

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
  }

  /**
   * Add events to timeline with deduplication
   */
  addEvents(newEvents: NostrEvent[]): NostrEvent[] {
    // Filter out duplicates
    const uniqueNewEvents = newEvents.filter(
      newEvent => !this.events.some(existing => existing.id === newEvent.id)
    );

    if (uniqueNewEvents.length > 0) {
      this.events.push(...uniqueNewEvents);
      this.events.sort((a, b) => b.created_at - a.created_at);
    }

    return uniqueNewEvents;
  }

  /**
   * Prepend events to beginning of timeline with deduplication
   */
  prependEvents(newEvents: NostrEvent[]): NostrEvent[] {
    // Filter out duplicates
    const uniqueNewEvents = newEvents.filter(
      newEvent => !this.events.some(existing => existing.id === newEvent.id)
    );

    if (uniqueNewEvents.length > 0) {
      this.events.unshift(...uniqueNewEvents);
      this.events.sort((a, b) => b.created_at - a.created_at);
    }

    return uniqueNewEvents;
  }

  /**
   * Add single event to beginning of timeline
   */
  addEvent(event: NostrEvent): boolean {
    // Check if event already exists
    if (this.events.some(existing => existing.id === event.id)) {
      return false;
    }

    this.events.unshift(event);
    this.events.sort((a, b) => b.created_at - a.created_at);
    return true;
  }

  /**
   * Remove event by ID
   */
  removeEvent(eventId: string): boolean {
    const initialLength = this.events.length;
    this.events = this.events.filter(event => event.id !== eventId);
    return this.events.length < initialLength;
  }

  /**
   * Trim events array to maxSize (keeps newest, removes oldest)
   */
  trimEvents(maxSize: number): void {
    if (this.events.length > maxSize) {
      this.events.splice(0, this.events.length - maxSize);
    }
  }

  /**
   * Clear all events
   */
  clearEvents(): void {
    this.events = [];
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
   * Include replies filter
   */
  getIncludeReplies(): boolean {
    return this.includeReplies;
  }

  setIncludeReplies(include: boolean): void {
    this.includeReplies = include;
  }

  /**
   * Selected relay filter
   */
  getSelectedRelay(): string | null {
    return this.selectedRelay;
  }

  setSelectedRelay(relayUrl: string | null): void {
    this.selectedRelay = relayUrl;
  }

  /**
   * Date range filter (time range mode)
   */
  getDateRange(): { since: number; until: number } | null {
    return this.dateRange;
  }

  setDateRange(range: { since: number; until: number }): void {
    this.dateRange = range;
  }

  clearDateRange(): void {
    this.dateRange = null;
  }

  /**
   * Reset all state (for refresh)
   */
  reset(): void {
    this.events = [];
    this.hasMore = true;
    // Keep loading, followingPubkeys, includeReplies, selectedRelay as they are
  }

  /**
   * Clear all state (for user switch)
   * Resets everything including following list
   */
  clear(): void {
    this.events = [];
    this.loading = false;
    this.hasMore = true;
    this.followingPubkeys = [];
    this.dateRange = null;
    // Keep filter preferences (includeReplies, selectedRelay) as user preference
  }
}
