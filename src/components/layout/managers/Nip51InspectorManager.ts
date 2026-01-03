/**
 * Nip51InspectorManager
 * Developer tool to inspect raw NIP-51 list events on relays
 *
 * @purpose View raw relay data for all NIP-51 lists without client-side filtering
 * @used-by MainLayout
 *
 * Features:
 * - Fetches directly via NostrTransport (bypasses Orchestrators)
 * - Shows ALL events including deleted ones (no NIP-09 filtering)
 * - Read-only view (no sync buttons)
 * - Displays: Bookmarks (kind:30003), Tribes (kind:30000), Mutes (kind:10000), Deletions (kind:5), Metadata (kind:30078)
 */

import { AuthService } from '../../../services/AuthService';
import { NostrTransport } from '../../../services/transport/NostrTransport';
import { RelayConfig } from '../../../services/RelayConfig';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

interface GroupedEvents {
  bookmarks: NostrEvent[];
  tribes: NostrEvent[];
  mutes: NostrEvent[];
  deletions: NostrEvent[];
  metadata: NostrEvent[];
}

export class Nip51InspectorManager {
  private containerElement: HTMLElement;
  private authService: AuthService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private events: GroupedEvents = {
    bookmarks: [],
    tribes: [],
    mutes: [],
    deletions: [],
    metadata: []
  };

  constructor(containerElement: HTMLElement) {
    this.containerElement = containerElement;
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
  }

  /**
   * Public render method (called by MainLayout)
   */
  public async renderListTab(container: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser) {
      container.innerHTML = `
        <div class="nip51-inspector-empty">
          <p>Log in to inspect your NIP-51 lists</p>
        </div>
      `;
      return;
    }

    // Show loading
    container.innerHTML = `
      <div class="nip51-inspector-loading">Loading NIP-51 events from relays...</div>
    `;

    try {
      await this.fetchAllEvents(currentUser.pubkey);
      this.renderEvents(container);
    } catch (error) {
      console.error('[Nip51InspectorManager] Failed to fetch events:', error);
      container.innerHTML = `
        <div class="nip51-inspector-error">
          <p>Failed to fetch events from relays</p>
        </div>
      `;
    }
  }

  /**
   * Fetch all NIP-51 related events directly from relays
   * NO filtering applied (raw relay data)
   */
  private async fetchAllEvents(pubkey: string): Promise<void> {
    const relays = this.relayConfig.getAllRelays().map(r => r.url);

    // Fetch all kinds in parallel
    const [bookmarks, tribes, mutes, deletions, metadata] = await Promise.all([
      // Bookmarks: kind:30003
      this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [30003]
      }], 5000),

      // Tribes: kind:30000
      this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [30000]
      }], 5000),

      // Mutes: kind:10000
      this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [10000]
      }], 5000),

      // Deletions: kind:5
      this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [5]
      }], 5000),

      // Metadata (NIP-78): kind:30078
      this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [30078]
      }], 5000)
    ]);

    // Sort each group by created_at DESC (newest first)
    this.events = {
      bookmarks: this.sortEvents(bookmarks),
      tribes: this.sortEvents(tribes),
      mutes: this.sortEvents(mutes),
      deletions: this.sortEvents(deletions),
      metadata: this.sortEvents(metadata)
    };

    console.log('[Nip51InspectorManager] Fetched events:', {
      bookmarks: this.events.bookmarks.length,
      tribes: this.events.tribes.length,
      mutes: this.events.mutes.length,
      deletions: this.events.deletions.length,
      metadata: this.events.metadata.length
    });
  }

  /**
   * Sort events by created_at DESC
   */
  private sortEvents(events: NostrEvent[]): NostrEvent[] {
    return events.sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * Render all events grouped by kind
   */
  private renderEvents(container: HTMLElement): void {
    const totalEvents =
      this.events.bookmarks.length +
      this.events.tribes.length +
      this.events.mutes.length +
      this.events.deletions.length +
      this.events.metadata.length;

    if (totalEvents === 0) {
      container.innerHTML = `
        <div class="nip51-inspector-empty">
          <h3>No NIP-51 Events Found</h3>
          <p>No events found on your configured relays.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="nip51-inspector">
        <div class="nip51-inspector-header">
          <h2>NIP-51 Inspector</h2>
          <p class="nip51-inspector-description">
            Raw relay data for all NIP-51 lists. No client-side filtering applied.
            <br>Total events: <strong>${totalEvents}</strong>
          </p>
        </div>

        <div class="nip51-inspector-content">
          ${this.renderEventGroup('Bookmarks', 'kind:30003', this.events.bookmarks, 30003)}
          ${this.renderEventGroup('Tribes', 'kind:30000', this.events.tribes, 30000)}
          ${this.renderEventGroup('Mutes', 'kind:10000', this.events.mutes, 10000)}
          ${this.renderEventGroup('Folder Order Metadata', 'kind:30078', this.events.metadata, 30078)}
          ${this.renderEventGroup('Deletions', 'kind:5', this.events.deletions, 5)}
        </div>
      </div>
    `;

    // Bind expand/collapse handlers for groups AND individual events
    this.bindGroupHandlers(container);
    this.bindEventHandlers(container);
  }

  /**
   * Render a group of events using nn-ui-toggle pattern
   */
  private renderEventGroup(title: string, kindLabel: string, events: NostrEvent[], kind: number): string {
    const eventItems = events.map((event, index) => this.renderEventItem(event, kind, index)).join('');
    const count = events.length;
    const countLabel = `${count} event${count !== 1 ? 's' : ''}`;

    return `
      <section class="nn-ui-toggle nip51-inspector-group" data-kind="${kind}">
        <div class="nn-ui-toggle__header">
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${title}</h2>
            <p class="nn-ui-toggle__description">
              ${kindLabel} • <span class="nip51-inspector-group__count">${countLabel}</span>
            </p>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${count > 0 ? `
            <div class="nip51-inspector-group__events">
              ${eventItems}
            </div>
          ` : `
            <div class="nip51-inspector-group__empty">No events found</div>
          `}
        </div>
      </section>
    `;
  }

  /**
   * Render a single event item
   */
  private renderEventItem(event: NostrEvent, kind: number, index: number): string {
    const timestamp = new Date(event.created_at * 1000).toLocaleString();
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
    const tagCount = event.tags.length;
    const hasContent = event.content && event.content.trim().length > 0;

    // Extract key tags for display
    const keyTags = this.extractKeyTags(event, kind);

    return `
      <div class="nip51-inspector-event" data-event-id="${event.id}">
        <div class="nip51-inspector-event__header">
          <div class="nip51-inspector-event__meta">
            <span class="nip51-inspector-event__id" title="${event.id}">${event.id.slice(0, 8)}...${event.id.slice(-8)}</span>
            ${dTag ? `<span class="nip51-inspector-event__dtag">${this.escapeHtml(dTag)}</span>` : ''}
            <span class="nip51-inspector-event__time">${timestamp}</span>
          </div>
          <button class="nip51-inspector-event__toggle" data-kind="${kind}" data-index="${index}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 9l6 6 6-6"></path>
            </svg>
          </button>
        </div>

        <div class="nip51-inspector-event__summary">
          <div class="nip51-inspector-event__tags-summary">
            ${keyTags}
          </div>
        </div>

        <div class="nip51-inspector-event__details" style="display: none;">
          <div class="nip51-inspector-event__section">
            <h4>Tags (${tagCount})</h4>
            <pre>${this.escapeHtml(JSON.stringify(event.tags, null, 2))}</pre>
          </div>
          ${hasContent ? `
            <div class="nip51-inspector-event__section">
              <h4>Content</h4>
              <pre>${this.escapeHtml(event.content)}</pre>
            </div>
          ` : ''}
          <div class="nip51-inspector-event__section">
            <h4>Full Event (JSON)</h4>
            <pre>${this.escapeHtml(JSON.stringify(event, null, 2))}</pre>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Extract key tags for summary display
   */
  private extractKeyTags(event: NostrEvent, kind: number): string {
    switch (kind) {
      case 30003: // Bookmarks
      case 30000: // Tribes
        const eTags = event.tags.filter(t => t[0] === 'e').length;
        const pTags = event.tags.filter(t => t[0] === 'p').length;
        const rTags = event.tags.filter(t => t[0] === 'r').length;
        const aTags = event.tags.filter(t => t[0] === 'a').length;
        const tags = [];
        if (eTags > 0) tags.push(`${eTags} event${eTags > 1 ? 's' : ''}`);
        if (pTags > 0) tags.push(`${pTags} pubkey${pTags > 1 ? 's' : ''}`);
        if (rTags > 0) tags.push(`${rTags} URL${rTags > 1 ? 's' : ''}`);
        if (aTags > 0) tags.push(`${aTags} coordinate${aTags > 1 ? 's' : ''}`);
        return tags.length > 0 ? tags.join(', ') : 'Empty';

      case 10000: // Mutes
        const publicP = event.tags.filter(t => t[0] === 'p').length;
        const publicE = event.tags.filter(t => t[0] === 'e').length;
        const hasPrivate = event.content && event.content.trim().length > 0;
        const parts = [];
        if (publicP > 0) parts.push(`${publicP} public user${publicP > 1 ? 's' : ''}`);
        if (publicE > 0) parts.push(`${publicE} public thread${publicE > 1 ? 's' : ''}`);
        if (hasPrivate) parts.push('private content');
        return parts.length > 0 ? parts.join(', ') : 'Empty';

      case 5: // Deletions
        const eDeletes = event.tags.filter(t => t[0] === 'e').length;
        const aDeletes = event.tags.filter(t => t[0] === 'a').length;
        const deletes = [];
        if (eDeletes > 0) deletes.push(`${eDeletes} event${eDeletes > 1 ? 's' : ''}`);
        if (aDeletes > 0) deletes.push(`${aDeletes} coordinate${aDeletes > 1 ? 's' : ''}`);
        return deletes.length > 0 ? `Deleting: ${deletes.join(', ')}` : 'No deletions';

      case 30078: // Metadata
        const metaATags = event.tags.filter(t => t[0] === 'a').length;
        return metaATags > 0 ? `${metaATags} folder${metaATags > 1 ? 's' : ''} ordered` : 'No order data';

      default:
        return `${event.tags.length} tag${event.tags.length > 1 ? 's' : ''}`;
    }
  }

  /**
   * Bind group accordion handlers (using standard .open class pattern)
   */
  private bindGroupHandlers(container: HTMLElement): void {
    const groupHeaders = container.querySelectorAll('.nip51-inspector-group .nn-ui-toggle__header');

    groupHeaders.forEach(header => {
      header.addEventListener('click', (e) => {
        const section = (e.currentTarget as HTMLElement).closest('.nn-ui-toggle');
        section?.classList.toggle('open');
      });
    });
  }

  /**
   * Bind individual event expand/collapse handlers
   */
  private bindEventHandlers(container: HTMLElement): void {
    const toggleButtons = container.querySelectorAll('.nip51-inspector-event__toggle');

    toggleButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        const eventItem = (e.currentTarget as HTMLElement).closest('.nip51-inspector-event');
        if (!eventItem) return;

        const details = eventItem.querySelector('.nip51-inspector-event__details') as HTMLElement;
        const toggleBtn = eventItem.querySelector('.nip51-inspector-event__toggle') as HTMLElement;

        if (details.style.display === 'none') {
          details.style.display = 'block';
          toggleBtn.classList.add('nip51-inspector-event__toggle--expanded');
        } else {
          details.style.display = 'none';
          toggleBtn.classList.remove('nip51-inspector-event__toggle--expanded');
        }
      });
    });
  }

  /**
   * Escape HTML for safe display
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    // No cleanup needed
  }
}
