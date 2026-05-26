/**
 * RelayBrowser Component
 * Displays all notes from a specific relay URL.
 * Works without login — buttons are always visible,
 * AuthGuard shows logged-out modals automatically on click.
 * Polls for new notes every 60 seconds.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import type { RelayBrowserModuleApi } from '../../modules/relay-browser/contracts';
import { NoteUI } from '../ui/NoteUI';
import { AuthService } from '../../services/AuthService';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { RefreshButton } from '../ui/RefreshButton';
import { escapeHtml } from '../../helpers/escapeHtml';

export class RelayBrowser {
  private element: HTMLElement;
  private notesContainer: HTMLElement;
  private relayBrowserApi: RelayBrowserModuleApi | null;
  private infiniteScroll: InfiniteScroll;
  private refreshButton: RefreshButton;
  private relayUrl: string;
  private isLoading: boolean = false;
  private hasMore: boolean = true;
  private pollingIntervalId: number | null = null;
  private polledEventsCache: NostrEvent[] = [];
  private readonly POLL_INTERVAL = 60000;

  constructor(relayUrl: string) {
    this.relayUrl = relayUrl;
    this.relayBrowserApi = ModuleLoader.getInstance().getApi<RelayBrowserModuleApi>('relay-browser');

    this.relayBrowserApi?.setRelay(relayUrl);

    this.refreshButton = new RefreshButton({
      newNotesCount: 0,
      authorPubkeys: [],
      onClick: () => this.handleRefreshClick()
    });

    this.element = this.createElement();
    this.notesContainer = this.element.querySelector('.relay-browser__notes') as HTMLElement;

    this.infiniteScroll = new InfiniteScroll(
      () => this.handleLoadMore(),
      { loadingMessage: 'Loading more notes...' }
    );

    this.initialize();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'relay-browser';

    // Extract domain from relay URL for display
    let displayDomain: string;
    try {
      displayDomain = new URL(this.relayUrl).host;
    } catch {
      displayDomain = this.relayUrl;
    }

    container.innerHTML = `
      <header class="relay-browser__header">
        <div class="relay-browser__header-left">
          <h1 class="relay-browser__title">${escapeHtml(displayDomain)}</h1>
          <span class="relay-browser__url">${escapeHtml(this.relayUrl)}</span>
        </div>
        <div class="relay-browser__header-right"></div>
      </header>
      <div class="relay-browser__notes"></div>
    `;

    // Insert RefreshButton into header right side
    const headerRight = container.querySelector('.relay-browser__header-right') as HTMLElement;
    headerRight.appendChild(this.refreshButton.getElement());

    return container;
  }

  private async initialize(): Promise<void> {
    this.showLoading();

    try {
      const result = await this.relayBrowserApi?.loadInitial() ?? { events: [], hasMore: false };
      this.hasMore = result.hasMore;

      if (result.events.length > 0) {
        ModuleLoader.getInstance().getApi<PostsModuleApi>('posts')?.registerNotes(result.events);
        this.renderNotes(result.events);
        this.infiniteScroll.observe(this.notesContainer);
        this.startPolling();
      } else {
        this.showEmpty();
      }
    } catch {
      this.showError();
    }
  }

  // ─── Polling ────────────────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    this.pollingIntervalId = window.setInterval(() => this.poll(), this.POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }

  private async poll(): Promise<void> {
    const newEvents = await this.relayBrowserApi?.pollNewNotes() ?? [];
    if (newEvents.length === 0) return;

    // Cache polled events (accumulate between refreshes)
    this.polledEventsCache = [...newEvents, ...this.polledEventsCache];

    // Extract unique author pubkeys (newest first, max 4)
    const authorPubkeys = [...new Set(this.polledEventsCache.map(e => e.pubkey))].slice(0, 4);

    this.refreshButton.update(this.polledEventsCache.length, authorPubkeys);
  }

  private handleRefreshClick(): void {
    if (this.polledEventsCache.length === 0) return;

    // Register and prepend cached notes
    ModuleLoader.getInstance().getApi<PostsModuleApi>('posts')?.registerNotes(this.polledEventsCache);
    this.prependNotes(this.polledEventsCache);

    // Clear cache
    this.polledEventsCache = [];

    // Scroll to top
    const primaryContent = document.querySelector('.primary-content');
    primaryContent?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ─── Note Rendering ─────────────────────────────────────────────────

  private renderNotes(events: NostrEvent[]): void {
    this.notesContainer.innerHTML = '';
    const isLoggedIn = AuthService.getInstance().hasValidSession();

    for (const event of events) {
      const noteEl = NoteUI.createNoteElement(event, {
        collapsible: true,
        islFetchStats: isLoggedIn,
        isLoggedIn,
        headerSize: 'medium',
        depth: 0
      });
      this.notesContainer.appendChild(noteEl);
    }
  }

  private prependNotes(events: NostrEvent[]): void {
    const isLoggedIn = AuthService.getInstance().hasValidSession();

    // Insert newest first at the top
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (!event) continue;
      const noteEl = NoteUI.createNoteElement(event, {
        collapsible: true,
        islFetchStats: isLoggedIn,
        isLoggedIn,
        headerSize: 'medium',
        depth: 0
      });
      this.notesContainer.insertBefore(noteEl, this.notesContainer.firstChild);
    }
  }

  private appendNotes(events: NostrEvent[]): void {
    const sentinel = this.notesContainer.querySelector('.infinite-scroll-sentinel');
    const isLoggedIn = AuthService.getInstance().hasValidSession();

    for (const event of events) {
      const noteEl = NoteUI.createNoteElement(event, {
        collapsible: true,
        islFetchStats: isLoggedIn,
        isLoggedIn,
        headerSize: 'medium',
        depth: 0
      });

      if (sentinel) {
        this.notesContainer.insertBefore(noteEl, sentinel);
      } else {
        this.notesContainer.appendChild(noteEl);
      }
    }
  }

  // ─── Infinite Scroll ────────────────────────────────────────────────

  private async handleLoadMore(): Promise<void> {
    if (this.isLoading || !this.hasMore) {
      this.infiniteScroll.disconnect();
      return;
    }

    this.isLoading = true;
    this.infiniteScroll.showLoading();

    try {
      const result = await this.relayBrowserApi?.loadMore() ?? { events: [], hasMore: false };
      this.hasMore = result.hasMore;

      if (result.events.length > 0) {
        ModuleLoader.getInstance().getApi<PostsModuleApi>('posts')?.registerNotes(result.events);
        this.appendNotes(result.events);
      }

      if (!this.hasMore) {
        this.infiniteScroll.disconnect();
      } else {
        this.infiniteScroll.hideLoading();
      }
    } catch {
      this.infiniteScroll.hideLoading();
    } finally {
      this.isLoading = false;
    }
  }

  // ─── State Displays ─────────────────────────────────────────────────

  private showLoading(): void {
    this.notesContainer.innerHTML = `
      <div class="relay-browser__loading">
        <div class="note-skeleton">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-body"></div>
          <div class="skeleton-line skeleton-meta"></div>
        </div>
        <div class="note-skeleton">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-body"></div>
          <div class="skeleton-line skeleton-meta"></div>
        </div>
        <div class="note-skeleton">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-body"></div>
          <div class="skeleton-line skeleton-meta"></div>
        </div>
      </div>
    `;
  }

  private showEmpty(): void {
    this.notesContainer.innerHTML = `
      <div class="relay-browser__empty">
        <svg width="48" height="48"><use href="#icon-search-clock"/></svg>
        <p>No notes found on this relay</p>
        <span>This relay may be empty or not responding</span>
      </div>
    `;
  }

  private showError(): void {
    this.notesContainer.innerHTML = `
      <div class="relay-browser__error">
        <svg width="48" height="48"><use href="#icon-close"/></svg>
        <p>Could not connect to relay</p>
        <span>${escapeHtml(this.relayUrl)}</span>
        <button class="btn btn--passive relay-browser__retry" data-action="retry">Retry</button>
      </div>
    `;

    const retryBtn = this.notesContainer.querySelector('[data-action="retry"]');
    retryBtn?.addEventListener('click', () => this.initialize());
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.stopPolling();
    this.infiniteScroll.destroy();
    this.refreshButton.destroy();
    NoteUI.cleanupAll();
    this.element.innerHTML = '';
  }
}
