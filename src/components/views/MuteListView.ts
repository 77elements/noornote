/**
 * MuteListView - Display and manage muted users and threads
 * Shows all muted users (public + private) and muted threads with unmute functionality
 * Uses ListSyncManager for Browser ↔ File ↔ Relay synchronization
 */

import { View } from './View';
import { MuteOrchestrator, type MuteStatus } from '../../services/orchestration/MuteOrchestrator';
import { UserProfileService, type UserProfile } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import { hexToNpub } from '../../helpers/nip19';
import { extractDisplayName } from '../../helpers/extractDisplayName';
import { ListSyncManager } from '../../services/sync/ListSyncManager';
import { MuteStorageAdapter } from '../../services/sync/adapters/MuteStorageAdapter';
import { SyncConfirmationModal } from '../modals/SyncConfirmationModal';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';

interface MutedUser {
  pubkey: string;
  profile: UserProfile;
  status: MuteStatus;
}

interface MutedThread {
  eventId: string;
  status: MuteStatus;
}

export class MuteListView extends View {
  private container: HTMLElement;
  private muteOrch: MuteOrchestrator;
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private listSyncManager: ListSyncManager<string>;
  private mutedUsers: MutedUser[] = [];
  private mutedThreads: MutedThread[] = [];

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'mute-list-view';
    this.muteOrch = MuteOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();

    const adapter = new MuteStorageAdapter();
    this.listSyncManager = new ListSyncManager(adapter);

    this.initializeBrowserStorage();
  }

  /**
   * Initialize browser storage from files (only if browser is empty)
   * This prevents overwriting user changes (like unmutes) when navigating back to this view
   */
  private async initializeBrowserStorage(): Promise<void> {
    const browserKey = 'noornote_mutes_browser_v2';
    const existingData = localStorage.getItem(browserKey);

    if (!existingData || existingData === '[]') {
      await this.listSyncManager.restoreFromFile().catch(() => {});
    }
  }

  public async render(): Promise<HTMLElement> {
    this.container.innerHTML = `
      <div class="mute-list-header">
        <h2>Mute List</h2>
        <p class="mute-list-description">Manage muted users and threads. Muted content won't appear in your timeline or notifications.</p>

        <div class="mute-list-actions">
          <div class="mute-list-actions__group">
            <button class="btn btn--small" id="sync-from-relays-btn">
              📥 Sync from Relays
            </button>
            <button class="btn btn--small" id="sync-to-relays-btn">
              📤 Sync to Relays
            </button>
          </div>

          <div class="mute-list-actions__group">
            <button class="btn btn--small btn--passive" id="save-to-file-btn">
              💾 Save to File
            </button>
            <button class="btn btn--small btn--passive" id="restore-from-file-btn">
              📂 Restore from File
            </button>
          </div>
        </div>
      </div>

      <div class="mute-list-content" id="mute-list-content">
        <div class="mute-list-loading">Loading mute list...</div>
      </div>
    `;

    this.loadMuteList();
    this.bindSyncButtons();
    this.bindFileButtons();

    return this.container;
  }

  private async loadMuteList(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.renderError('Please log in to view your mute list.');
      return;
    }

    try {
      const mutedUsersMap = await this.muteOrch.getAllMutedUsersWithStatus(currentUser.pubkey);
      this.mutedUsers = await Promise.all(
        Array.from(mutedUsersMap.entries()).map(async ([pubkey, status]) => ({
          pubkey,
          profile: await this.userProfileService.getUserProfile(pubkey),
          status
        }))
      );

      const mutedThreadsMap = await this.muteOrch.getAllMutedThreadsWithStatus();
      this.mutedThreads = Array.from(mutedThreadsMap.entries()).map(([eventId, status]) => ({
        eventId,
        status
      }));

      this.renderMuteList();
    } catch {
      this.renderError('Failed to load mute list. Please try again.');
    }
  }

  private renderMuteList(): void {
    const content = this.container.querySelector('#mute-list-content');
    if (!content) return;

    const hasUsers = this.mutedUsers.length > 0;
    const hasThreads = this.mutedThreads.length > 0;

    if (!hasUsers && !hasThreads) {
      content.innerHTML = `
        <div class="mute-list-empty">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 12l24 24M24 6v12a6 6 0 0 0 12 0M24 18v12a6 6 0 1 1-12 0V18a6 6 0 0 1 12 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <h3>No Muted Content</h3>
          <p>You haven't muted anyone or any threads yet.</p>
        </div>
      `;
      return;
    }

    let sectionsHtml = '';

    if (hasUsers) {
      sectionsHtml += this.renderUsersSection();
    }

    if (hasThreads) {
      sectionsHtml += this.renderThreadsSection();
    }

    content.innerHTML = sectionsHtml;

    setupUserMentionHandlers(content as HTMLElement);
    this.bindUnmuteListeners();
  }

  private renderUsersSection(): string {
    const userItems = this.mutedUsers
      .map(({ pubkey, profile, status }) => {
        const username = extractDisplayName(profile);
        const npub = hexToNpub(pubkey);
        const avatarUrl = profile.picture || '';
        const lockIcon = status.private ? '<span class="mute-list-item__badge mute-list-item__badge--private">🔒</span>' : '';

        return `
          <div class="mute-list-item" data-pubkey="${pubkey}">
            <div class="mute-list-item__info">
              <span class="user-mention" data-pubkey="${pubkey}">
                <a href="/profile/${npub}" class="mention-link mention-link--bg" data-profile-pubkey="${pubkey}">
                  <img class="profile-pic profile-pic--mini" src="${avatarUrl}" alt="${username}" />${username}</a></span>${lockIcon}
            </div>
            <button class="btn btn--passive btn--small unmute-user-btn" data-pubkey="${pubkey}">
              Unmute
            </button>
          </div>
        `;
      })
      .join('');

    return `
      <div class="mute-list-section">
        <div class="mute-list-section__header">
          <h3 class="mute-list-section__title">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M2 14c0-3 2.5-5 6-5s6 2 6 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            Muted Users
            <span class="mute-list-section__count">${this.mutedUsers.length}</span>
          </h3>
        </div>
        <div class="mute-list-items">
          ${userItems}
        </div>
      </div>
    `;
  }

  private renderThreadsSection(): string {
    const threadItems = this.mutedThreads
      .map(({ eventId, status }) => {
        const lockIcon = status.private ? '<span class="mute-list-item__badge mute-list-item__badge--private">🔒</span>' : '';
        const shortId = eventId.slice(0, 8) + '...' + eventId.slice(-8);

        return `
          <div class="mute-list-item mute-list-item--thread" data-event-id="${eventId}">
            <div class="mute-list-item__info">
              <div class="mute-list-item__thread-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2 3h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <span class="mute-list-item__event-id" title="${eventId}">${shortId}${lockIcon}</span>
            </div>
            <button class="btn btn--passive btn--small unmute-thread-btn" data-event-id="${eventId}">
              Unmute
            </button>
          </div>
        `;
      })
      .join('');

    return `
      <div class="mute-list-section">
        <div class="mute-list-section__header">
          <h3 class="mute-list-section__title">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 3h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Muted Threads
            <span class="mute-list-section__count">${this.mutedThreads.length}</span>
          </h3>
          <p class="mute-list-section__description">Threads you muted to stop notifications from replies.</p>
        </div>
        <div class="mute-list-items">
          ${threadItems}
        </div>
      </div>
    `;
  }

  private renderError(message: string): void {
    const content = this.container.querySelector('#mute-list-content');
    if (!content) return;

    content.innerHTML = `
      <div class="mute-list-error">
        <p>${message}</p>
      </div>
    `;
  }

  private bindUnmuteListeners(): void {
    this.container.querySelectorAll('.unmute-user-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const pubkey = (e.currentTarget as HTMLElement).dataset.pubkey;
        if (pubkey) await this.handleUnmuteUser(pubkey);
      });
    });

    this.container.querySelectorAll('.unmute-thread-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const eventId = (e.currentTarget as HTMLElement).dataset.eventId;
        if (eventId) await this.handleUnmuteThread(eventId);
      });
    });
  }

  private bindSyncButtons(): void {
    this.bindButton('#sync-from-relays-btn', () => this.handleSyncFromRelays());
    this.bindButton('#sync-to-relays-btn', () => this.handleSyncToRelays());
  }

  private bindFileButtons(): void {
    this.bindButton('#save-to-file-btn', () => this.handleSaveToFile());
    this.bindButton('#restore-from-file-btn', () => this.handleRestoreFromFile());
  }

  private bindButton(selector: string, handler: () => Promise<void>): void {
    const btn = this.container.querySelector(selector);
    if (btn) {
      btn.addEventListener('click', handler);
    }
  }

  private async handleSyncFromRelays(): Promise<void> {
    try {
      ToastService.show('Fetching from relays...', 'info');
      const result = await this.listSyncManager.syncFromRelays();

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: 'Mute List',
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: (pubkey: string) => {
            const user = this.mutedUsers.find(u => u.pubkey === pubkey);
            return user ? extractDisplayName(user.profile) : pubkey.slice(0, 8) + '...';
          },
          onKeep: async () => {
            await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
            ToastService.show(`Merged ${result.diff.added.length} new mutes (kept ${result.diff.removed.length} local mutes)`, 'success');
            await this.loadMuteList();
          },
          onDelete: async () => {
            await this.listSyncManager.applySyncFromRelays('overwrite', result.relayItems, result.relayContentWasEmpty);
            ToastService.show(`Synced from relays (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            await this.loadMuteList();
          }
        });
        modal.show();
      } else {
        await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
        ToastService.show(`Synced ${result.diff.added.length} new mute${result.diff.added.length > 1 ? 's' : ''} from relays`, 'success');
        await this.loadMuteList();
      }
    } catch {
      ToastService.show('Failed to sync from relays', 'error');
    }
  }

  private async handleSyncToRelays(): Promise<void> {
    try {
      ToastService.show('Publishing to relays...', 'info');
      await this.listSyncManager.syncToRelays();
      ToastService.show('Mute list published successfully', 'success');
    } catch {
      ToastService.show('Failed to publish to relays', 'error');
    }
  }

  private async handleSaveToFile(): Promise<void> {
    try {
      ToastService.show('Saving to file...', 'info');
      await this.listSyncManager.saveToFile();
      ToastService.show('Saved to local file', 'success');
    } catch {
      ToastService.show('Failed to save to file', 'error');
    }
  }

  private async handleRestoreFromFile(): Promise<void> {
    try {
      ToastService.show('Restoring from file...', 'info');
      await this.listSyncManager.restoreFromFile();
      ToastService.show('Restored from local file', 'success');
      await this.loadMuteList();
    } catch {
      ToastService.show('Failed to restore from file', 'error');
    }
  }

  private async handleUnmuteUser(pubkey: string): Promise<void> {
    try {
      await this.muteOrch.unmuteUserCompletely(pubkey);
      ToastService.show('User unmuted', 'success');

      this.mutedUsers = this.mutedUsers.filter(u => u.pubkey !== pubkey);
      this.renderMuteList();

      const { FeedOrchestrator } = await import('../../services/orchestration/FeedOrchestrator');
      const { NotificationsOrchestrator } = await import('../../services/orchestration/NotificationsOrchestrator');

      await Promise.all([
        FeedOrchestrator.getInstance().refreshMutedUsers(),
        NotificationsOrchestrator.getInstance().refreshMutedUsers()
      ]);

      EventBus.getInstance().emit('mute:updated', {});
    } catch {
      ToastService.show('Failed to unmute user', 'error');
    }
  }

  private async handleUnmuteThread(eventId: string): Promise<void> {
    try {
      await this.muteOrch.unmuteThread(eventId);
      ToastService.show('Thread unmuted', 'success');

      this.mutedThreads = this.mutedThreads.filter(t => t.eventId !== eventId);
      this.renderMuteList();

      const eventBus = EventBus.getInstance();
      eventBus.emit('mute:thread:updated', { eventId });
      eventBus.emit('mute:updated', {});
    } catch {
      ToastService.show('Failed to unmute thread', 'error');
    }
  }

  public destroy(): void {
    this.container.remove();
  }
}
