/**
 * MuteListSecondaryManager
 * Manages mute list tab in secondary-content sidebar
 * Uses ListSyncManager for Browser ↔ File ↔ Relay synchronization
 * Implements infinite scroll for large lists
 * Displays both muted users AND muted threads
 *
 * @purpose Handle mute list rendering, sync operations, and unmute
 * @used-by MainLayout
 */

import { BaseListSecondaryManager } from './BaseListSecondaryManager';
import { MuteOrchestrator, type MuteStatus } from '../../../services/orchestration/MuteOrchestrator';
import { UserProfileService } from '../../../services/UserProfileService';
import { ToastService } from '../../../services/ToastService';
import { Router } from '../../../services/Router';
import { hexToNpub } from '../../../helpers/nip19';
import { extractDisplayName } from '../../../helpers/extractDisplayName';
import { ListSyncManager } from '../../../services/sync/ListSyncManager';
import { MuteStorageAdapter } from '../../../services/sync/adapters/MuteStorageAdapter';
import { NostrTransport } from '../../../services/transport/NostrTransport';
import type { UserProfile } from '../../../services/UserProfileService';

interface MuteItemWithProfile {
  pubkey: string;
  status: MuteStatus;
  profile: UserProfile;
}

interface MutedThread {
  eventId: string;
  status: MuteStatus;
  content?: string; // Truncated note content
}

export class MuteListSecondaryManager extends BaseListSecondaryManager<string, MuteItemWithProfile> {
  private muteOrch: MuteOrchestrator;
  private userProfileService: UserProfileService;
  private router: Router;
  private mutedThreads: MutedThread[] = [];
  private adapter: MuteStorageAdapter;

  constructor(containerElement: HTMLElement) {
    const adapter = new MuteStorageAdapter();
    const listSyncManager = new ListSyncManager(adapter);

    super(containerElement, listSyncManager);

    this.adapter = adapter;
    this.muteOrch = MuteOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();

    // Additional user:login handler for mutedThreads cache
    this.eventBus.on('user:login', () => {
      this.mutedThreads = [];
    });
  }

  /**
   * Abstract method implementations
   */

  protected getEventName(): string {
    return 'mute:updated';
  }

  protected getTabDataAttribute(): string {
    return 'list-mutes';
  }

  protected getListContainerClass(): string {
    return 'mutes-list';
  }

  protected getListType(): string {
    return 'Mute List';
  }

  protected async getDisplayNameForSync(pubkey: string): Promise<string> {
    const profile = await this.userProfileService.getUserProfile(pubkey);
    return extractDisplayName(profile);
  }

  /**
   * Fetch all muted users with profiles
   * Reads from BROWSER storage (localStorage) - source of truth during session
   *
   * Note: Does NOT call restoreIfEmpty() here - that should only happen
   * during initial app startup, not on every refresh. Otherwise unmuting
   * would be immediately reverted by restoring from file.
   */
  protected async getAllItemsWithProfiles(): Promise<MuteItemWithProfile[]> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    // Read ALL muted pubkeys from browser storage (public + private merged)
    const allMutedPubkeys = await this.muteOrch.getAllMutedUsers();

    // Get public/private status from browser storage
    const muteStatus = await this.muteOrch.getAllMutedUsersWithStatus();

    // Fetch profiles for all muted users
    const mutesWithProfiles: MuteItemWithProfile[] = await Promise.all(
      allMutedPubkeys.map(async (pubkey) => {
        const status = muteStatus.get(pubkey);
        return {
          pubkey,
          status: status || { public: true, private: false },
          profile: await this.userProfileService.getUserProfile(pubkey)
        };
      })
    );

    // Also load muted threads with content
    const threadsMap = await this.muteOrch.getAllMutedThreadsWithStatus();
    const threadEntries = Array.from(threadsMap.entries());

    // Fetch event content for threads
    if (threadEntries.length > 0) {
      const transport = NostrTransport.getInstance();
      const eventIds = threadEntries.map(([id]) => id);

      try {
        const events = await transport.fetch(transport.getReadRelays(), [{
          ids: eventIds,
          kinds: [1]
        }], 5000);

        const eventMap = new Map(events.map(e => [e.id, e.content]));

        this.mutedThreads = threadEntries.map(([eventId, status]) => ({
          eventId,
          status,
          content: eventMap.get(eventId)
        }));
      } catch {
        // Fallback: no content
        this.mutedThreads = threadEntries.map(([eventId, status]) => ({
          eventId,
          status
        }));
      }
    } else {
      this.mutedThreads = [];
    }

    return mutesWithProfiles;
  }

  /**
   * Override renderListTab to show both users and threads
   */
  public override async renderListTab(content: HTMLElement): Promise<void> {
    // Show loading state
    content.innerHTML = `
      <div class="list-loading">
        <div class="spinner"></div>
        <p>Loading mute list...</p>
      </div>
    `;

    try {
      // Load all items (users and threads)
      this.allItemsWithProfiles = await this.getAllItemsWithProfiles();

      const hasUsers = this.allItemsWithProfiles.length > 0;
      const hasThreads = this.mutedThreads.length > 0;

      if (!hasUsers && !hasThreads) {
        content.innerHTML = this.renderControlButtons() + `
          <div class="list-empty">
            <p>No muted users or threads</p>
          </div>
        ` + this.renderControlButtons();
        this.bindSyncButtons(content);
        return;
      }

      // Build content with sections
      let html = this.renderControlButtons();

      // Users Section
      if (hasUsers) {
        html += `
          <div class="mute-section">
            <div class="mute-section__header">
              <span class="mute-section__title">Muted Users</span>
              <span class="badge">${this.allItemsWithProfiles.length}</span>
            </div>
            <div class="mutes-list mutes-list--users"></div>
          </div>
        `;
      }

      // Threads Section
      if (hasThreads) {
        html += `
          <div class="mute-section">
            <div class="mute-section__header">
              <span class="mute-section__title">Muted Threads</span>
              <span class="badge">${this.mutedThreads.length}</span>
            </div>
            <div class="mutes-list mutes-list--threads"></div>
          </div>
        `;
      }

      // Add control buttons at bottom
      html += this.renderControlButtons();

      content.innerHTML = html;

      // Bind sync button handlers
      this.bindSyncButtons(content);

      // Render users
      if (hasUsers) {
        const usersContainer = content.querySelector('.mutes-list--users');
        if (usersContainer) {
          this.renderBatch(usersContainer as HTMLElement, this.allItemsWithProfiles);
        }
      }

      // Render threads
      if (hasThreads) {
        const threadsContainer = content.querySelector('.mutes-list--threads');
        if (threadsContainer) {
          this.renderThreadsBatch(threadsContainer as HTMLElement, this.mutedThreads);
        }
      }

    } catch (error) {
      console.error('Failed to load mute list:', error);
      content.innerHTML = `
        <div class="list-error">
          <p>Failed to load mute list</p>
        </div>
      `;
    }
  }

  /**
   * Render batch of mute items (users)
   */
  protected renderBatch(listElement: HTMLElement, batch: MuteItemWithProfile[]): void {
    for (const item of batch) {
      const username = extractDisplayName(item.profile);
      const npub = hexToNpub(item.pubkey);
      const avatarUrl = item.profile?.picture || '';

      const muteItemDiv = document.createElement('div');
      muteItemDiv.className = 'ui-list__item mute-item';
      muteItemDiv.dataset.pubkey = item.pubkey;
      muteItemDiv.innerHTML = `
        <div class="mute-item__content-wrapper">
          <div class="mute-item__avatar">
            <img class="profile-pic profile-pic--medium" src="${avatarUrl}" alt="${username}" />
          </div>
          <div class="mute-item__info">
            <div class="mute-item__username">
              ${this.escapeHtml(username)}
              ${item.status.private ? '<span class="private-badge">🔒 Private</span>' : ''}
            </div>
          </div>
        </div>
        <button class="mute-item__unmute-btn btn btn--passive btn--small" data-pubkey="${item.pubkey}">
          Unmute
        </button>
      `;

      // Click on content wrapper navigates to profile
      const contentWrapper = muteItemDiv.querySelector('.mute-item__content-wrapper');
      contentWrapper?.addEventListener('click', () => {
        this.router.navigate(`/profile/${npub}`);
      });

      // Click on unmute button removes mute
      const unmuteBtn = muteItemDiv.querySelector('.mute-item__unmute-btn');
      unmuteBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.handleRemoveItem(item, muteItemDiv);
      });

      // Insert before sentinel (if it exists)
      const sentinel = listElement.querySelector('.infinite-scroll-sentinel');
      if (sentinel) {
        listElement.insertBefore(muteItemDiv, sentinel);
      } else {
        listElement.appendChild(muteItemDiv);
      }
    }
  }

  /**
   * Render batch of muted threads
   */
  private renderThreadsBatch(listElement: HTMLElement, threads: MutedThread[]): void {
    for (const thread of threads) {
      // Truncate content to ~80 chars
      const truncatedContent = thread.content
        ? (thread.content.length > 80 ? thread.content.slice(0, 80) + '...' : thread.content)
        : 'Content unavailable';

      const threadDiv = document.createElement('div');
      threadDiv.className = 'ui-list__item mute-item mute-item--thread';
      threadDiv.dataset.eventId = thread.eventId;
      threadDiv.innerHTML = `
        <div class="mute-item__content-wrapper">
          <div class="mute-item__thread-icon">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 3h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="mute-item__info">
            <div class="mute-item__thread-content" title="${this.escapeHtml(thread.content || '')}">
              ${this.escapeHtml(truncatedContent)}
              ${thread.status.private ? '<span class="private-badge">🔒</span>' : ''}
            </div>
          </div>
        </div>
        <button class="mute-item__unmute-btn btn btn--passive btn--small" data-event-id="${thread.eventId}">
          Unmute
        </button>
      `;

      // Click on content navigates to thread
      const contentWrapper = threadDiv.querySelector('.mute-item__content-wrapper');
      contentWrapper?.addEventListener('click', () => {
        this.router.navigate(`/note/${thread.eventId}`);
      });

      // Click on unmute button removes thread mute
      const unmuteBtn = threadDiv.querySelector('.mute-item__unmute-btn');
      unmuteBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.handleUnmuteThread(thread.eventId, threadDiv);
      });

      listElement.appendChild(threadDiv);
    }
  }

  /**
   * Handle unmute user (remove item)
   */
  protected async handleRemoveItem(item: MuteItemWithProfile, itemElement: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    try {
      await this.muteOrch.unmuteUserCompletely(item.pubkey);
      ToastService.show('User unmuted', 'success');

      itemElement.remove();

      // Update cached list
      this.allItemsWithProfiles = this.allItemsWithProfiles.filter(m => m.pubkey !== item.pubkey);

      // Refresh feed orchestrators
      const { FeedOrchestrator } = await import('../../../services/orchestration/FeedOrchestrator');
      const { NotificationsOrchestrator } = await import('../../../services/orchestration/NotificationsOrchestrator');

      const feedOrch = FeedOrchestrator.getInstance();
      const notifOrch = NotificationsOrchestrator.getInstance();

      await Promise.all([
        feedOrch.refreshMutedUsers(),
        notifOrch.refreshMutedUsers()
      ]);

      this.eventBus.emit('mute:updated', {});
    } catch (error) {
      console.error('Failed to unmute user:', error);
      ToastService.show('Failed to unmute user', 'error');
    }
  }

  /**
   * Handle unmute thread
   */
  private async handleUnmuteThread(eventId: string, itemElement: HTMLElement): Promise<void> {
    try {
      await this.muteOrch.unmuteThread(eventId);
      ToastService.show('Thread unmuted', 'success');

      itemElement.remove();

      // Update cached list
      this.mutedThreads = this.mutedThreads.filter(t => t.eventId !== eventId);

      this.eventBus.emit('mute:thread:updated', { eventId });
      this.eventBus.emit('mute:updated', {});
    } catch (error) {
      console.error('Failed to unmute thread:', error);
      ToastService.show('Failed to unmute thread', 'error');
    }
  }

  /**
   * Handle tab switch (called by MainLayout)
   */
  public handleTabSwitch(tabName: string, content: HTMLElement): void {
    if (tabName === 'mutes') {
      this.renderListTab(content).catch(err => {
        console.error('Failed to render mutes tab:', err);
      });
    }
  }
}
