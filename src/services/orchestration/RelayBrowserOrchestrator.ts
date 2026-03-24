/**
 * RelayBrowserOrchestrator - Browse All Notes on a Specific Relay
 * Fetches and paginates notes from a single relay URL (no authors filter).
 * Used by the ?r= relay browser feature.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';

export interface RelayBrowserResult {
  events: NostrEvent[];
  hasMore: boolean;
}

export class RelayBrowserOrchestrator extends Orchestrator {
  private static instance: RelayBrowserOrchestrator;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  private relayUrl: string = '';
  private seenIds: Set<string> = new Set();
  private oldestTimestamp: number = Math.floor(Date.now() / 1000);
  private newestTimestamp: number = 0;
  private readonly PAGE_SIZE = 30;

  private constructor() {
    super('RelayBrowserOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): RelayBrowserOrchestrator {
    if (!RelayBrowserOrchestrator.instance) {
      RelayBrowserOrchestrator.instance = new RelayBrowserOrchestrator();
    }
    return RelayBrowserOrchestrator.instance;
  }

  // Abstract method stubs (not using router pattern)
  public onui(_data: unknown): void {}
  public onopen(_relay: string): void {}
  public onmessage(_relay: string, _event: NostrEvent): void {}
  public onerror(_relay: string, _error: Error): void {}
  public onclose(_relay: string): void {}

  /**
   * Set the relay URL and reset pagination state
   */
  public setRelay(url: string): void {
    // Normalize: remove trailing slash so NDK matches existing pool entries
    this.relayUrl = url.replace(/\/+$/, '');
    this.reset();
  }

  /**
   * Load initial notes from the relay
   */
  public async loadInitial(): Promise<RelayBrowserResult> {
    this.reset();
    const result = await this.fetchNotes();

    // Track newest timestamp for polling
    const newest = result.events[0];
    if (newest) {
      this.newestTimestamp = newest.created_at || 0;
    }

    return result;
  }

  /**
   * Load more notes (pagination)
   */
  public async loadMore(): Promise<RelayBrowserResult> {
    return this.fetchNotes();
  }

  /**
   * Poll for new notes since the newest known timestamp
   */
  public async pollNewNotes(): Promise<NostrEvent[]> {
    if (!this.relayUrl || this.newestTimestamp === 0) return [];

    try {
      const filter = {
        kinds: [1, 6, 20, 21, 22, 1068],
        since: this.newestTimestamp + 1,
        limit: 50
      };

      const events = await this.transport.fetch([this.relayUrl], [filter], 8000, true, 'RelayBrowserOrch');

      // Deduplicate against already-seen events
      const newEvents = events.filter(e => {
        const id = e.id || '';
        if (!id || this.seenIds.has(id)) return false;
        this.seenIds.add(id);
        return true;
      });

      // Sort newest first
      newEvents.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

      // Track newest timestamp BEFORE filtering (so next poll doesn't miss events)
      const newestPolled = newEvents[0];
      if (newestPolled) {
        this.newestTimestamp = newestPolled.created_at || this.newestTimestamp;
        this.systemLogger.info(
          'RelayBrowser',
          `Polled ${newEvents.length} new notes from ${this.relayUrl}`
        );
      }

      // Filter content words
      const { isContentWordFilterEnabled, filterContentWords, getFilterWords } = await import('../../addons/content-word-filter/index');
      if (isContentWordFilterEnabled()) {
        const filtered = filterContentWords(newEvents);
        const removed = newEvents.length - filtered.length;
        if (removed > 0) {
          diagLog('system', `Word filter: removed ${removed} polled notes from relay browser (${this.relayUrl})`, { words: getFilterWords() });
        }
        return filtered;
      }
      return newEvents;
    } catch {
      return [];
    }
  }

  private reset(): void {
    this.oldestTimestamp = Math.floor(Date.now() / 1000);
    this.newestTimestamp = 0;
    this.seenIds.clear();
  }

  private async fetchNotes(): Promise<RelayBrowserResult> {
    try {
      // Ensure the relay is connected (it may be in the pool but disconnected)
      await this.transport.connectToRelay(this.relayUrl);

      const filter = {
        kinds: [1, 6, 20, 21, 22, 1068],
        until: this.oldestTimestamp,
        limit: this.PAGE_SIZE + 5
      };

      const events = await this.transport.fetch([this.relayUrl], [filter], 8000, true, 'RelayBrowserOrch');

      // Deduplicate
      const unique = events.filter(e => {
        const id = e.id || '';
        if (!id || this.seenIds.has(id)) return false;
        this.seenIds.add(id);
        return true;
      });

      // Sort newest first
      unique.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

      // Filter content words
      const { isContentWordFilterEnabled, filterContentWords, getFilterWords } = await import('../../addons/content-word-filter/index');
      const filtered = isContentWordFilterEnabled() ? filterContentWords(unique) : unique;
      const removedCount = unique.length - filtered.length;
      if (removedCount > 0) {
        diagLog('system', `Word filter: removed ${removedCount} notes from relay browser (${this.relayUrl})`, { words: getFilterWords() });
      }

      const hasMore = filtered.length > this.PAGE_SIZE;
      const toReturn = filtered.slice(0, this.PAGE_SIZE);

      // Update oldest timestamp for next page
      const oldest = toReturn[toReturn.length - 1];
      if (oldest) {
        this.oldestTimestamp = (oldest.created_at || 0) - 1;
      }

      this.systemLogger.info(
        'RelayBrowser',
        `Fetched ${toReturn.length} notes from ${this.relayUrl}, hasMore: ${hasMore}`
      );

      return { events: toReturn, hasMore };
    } catch (error) {
      this.systemLogger.error('RelayBrowser', `Failed to fetch from ${this.relayUrl}`);
      return { events: [], hasMore: false };
    }
  }
}
