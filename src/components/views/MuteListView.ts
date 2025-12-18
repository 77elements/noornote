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

    // Initialize ListSyncManager with MuteStorageAdapter
    const adapter = new MuteStorageAdapter();
    this.listSyncManager = new ListSyncManager(adapter);

    // Initialize browser storage from files on first load
    this.initializeBrowserStorage();
  }

  /**
   * Initialize browser storage from files (only if browser is empty)
   * This prevents overwriting user changes (like unmutes) when navigating back to this view
   */
  private async initializeBrowserStorage(): Promise<void> {
    try {
      // Check if browser storage already has data
      const browserKey = 'noornote_mutes_browser_v2';
      const existingData = localStorage.getItem(browserKey);

      if (!existingData || existingData === '[]') {
        // Only restore from file if browser storage is empty
        await this.listSyncManager.restoreFromFile();
      }
    } catch (_error) {
      console.error('[MuteListView] Failed to initialize browser storage:', _error);
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
    this.bindSyncFromRelaysButton();
    this.bindSyncToRelaysButton();
    this.bindSaveToFileButton();
    this.bindRestoreFromFileButton();

    return this.container;
  }

  private async loadMuteList(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.renderError('Please log in to view your mute list.');
      return;
    }

    try {
      // Load muted users with profiles
      const mutedUsersMap = await this.muteOrch.getAllMutedUsersWithStatus(currentUser.pubkey);
      this.mutedUsers = await Promise.all(
        Array.from(mutedUsersMap.entries()).map(async ([pubkey, status]) => ({
          pubkey,
          profile: await this.userProfileService.getUserProfile(pubkey),
          status
        }))
      );

      // Load muted threads
      const mutedThreadsMap = await this.muteOrch.getAllMutedThreadsWithStatus();
      this.mutedThreads = Array.from(mutedThreadsMap.entries()).map(([eventId, status]) => ({
        eventId,
        status
      }));

      this.renderMuteList();
    } catch (_error) {
      console.error('Failed to load mute list:', _error);
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

    // Build sections HTML
    let sectionsHtml = '';

    // Users Section
    if (hasUsers) {
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

      sectionsHtml += `
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

    // Threads Section
    if (hasThreads) {
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

      sectionsHtml += `
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

    content.innerHTML = sectionsHtml;

    // Setup hover cards for user mentions
    setupUserMentionHandlers(content as HTMLElement);

    this.bindUnmuteUserListeners();
    this.bindUnmuteThreadListeners();
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

  private bindUnmuteUserListeners(): void {
    const unmuteButtons = this.container.querySelectorAll('.unmute-user-btn');

    unmuteButtons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const target = e.currentTarget as HTMLElement;
        const pubkey = target.dataset.pubkey;

        if (!pubkey) return;

        await this.handleUnmuteUser(pubkey);
      });
    });
  }

  private bindUnmuteThreadListeners(): void {
    const unmuteButtons = this.container.querySelectorAll('.unmute-thread-btn');

    unmuteButtons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const target = e.currentTarget as HTMLElement;
        const eventId = target.dataset.eventId;

        if (!eventId) return;

        await this.handleUnmuteThread(eventId);
      });
    });
  }

  /**
   * Button 1: Sync from Relays (Relay → Browser)
   * Phase 1: Fetch + Compare
   * Phase 2: Show modal if needed
   * Phase 3: Apply after user decision
   */
  private bindSyncFromRelaysButton(): void {
    const syncBtn = this.container.querySelector('#sync-from-relays-btn');
    if (!syncBtn) return;

    syncBtn.addEventListener('click', async () => {
      try {
        ToastService.show('Fetching from relays...', 'info');

        // Phase 1: Fetch + Compare (NO changes to browser storage yet)
        const result = await this.listSyncManager.syncFromRelays();

        if (result.requiresConfirmation) {
          // Browser has MORE items than relay → Show confirmation modal
          const modal = new SyncConfirmationModal({
            listType: 'Mute List',
            added: result.diff.added,
            removed: result.diff.removed,
            getDisplayName: (pubkey: string) => {
              const user = this.mutedUsers.find(u => u.pubkey === pubkey);
              return user ? extractDisplayName(user.profile) : pubkey.slice(0, 8) + '...';
            },
            onKeep: async () => {
              // User chose "Beibehalten" → Merge strategy
              await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
              ToastService.show(`Merged ${result.diff.added.length} new mutes (kept ${result.diff.removed.length} local mutes)`, 'success');
              await this.loadMuteList();
            },
            onDelete: async () => {
              // User chose "Hier auch löschen" → Overwrite strategy
              await this.listSyncManager.applySyncFromRelays('overwrite', result.relayItems, result.relayContentWasEmpty);
              ToastService.show(`Synced from relays (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
              await this.loadMuteList();
            }
          });

          modal.show();
        } else {
          // Browser has LESS/EQUAL items → Auto-merge
          await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
          ToastService.show(`Synced ${result.diff.added.length} new mute${result.diff.added.length > 1 ? 's' : ''} from relays`, 'success');
          await this.loadMuteList();
        }
      } catch (_error) {
        console.error('Failed to sync from relays:', _error);
        ToastService.show('Failed to sync from relays', 'error');
      }
    });
  }

  /**
   * Button 2: Sync to Relays (Browser → Relay)
   * Always overwrites relay list with browser list
   */
  private bindSyncToRelaysButton(): void {
    const syncBtn = this.container.querySelector('#sync-to-relays-btn');
    if (!syncBtn) return;

    syncBtn.addEventListener('click', async () => {
      try {
        ToastService.show('Publishing to relays...', 'info');
        await this.listSyncManager.syncToRelays();
        ToastService.show('Mute list published successfully', 'success');
      } catch (_error) {
        console.error('Failed to publish to relays:', _error);
        ToastService.show('Failed to publish to relays', 'error');
      }
    });
  }

  /**
   * Button 3: Save to File (Browser → File)
   * Always overwrites file with browser list
   */
  private bindSaveToFileButton(): void {
    const saveBtn = this.container.querySelector('#save-to-file-btn');
    if (!saveBtn) return;

    saveBtn.addEventListener('click', async () => {
      try {
        ToastService.show('Saving to file...', 'info');
        await this.listSyncManager.saveToFile();
        ToastService.show('Saved to local file', 'success');
      } catch (_error) {
        console.error('Failed to save to file:', _error);
        ToastService.show('Failed to save to file', 'error');
      }
    });
  }

  /**
   * Button 4: Restore from File (File → Browser)
   */
  private bindRestoreFromFileButton(): void {
    const restoreBtn = this.container.querySelector('#restore-from-file-btn');
    if (!restoreBtn) return;

    restoreBtn.addEventListener('click', async () => {
      try {
        ToastService.show('Restoring from file...', 'info');
        await this.listSyncManager.restoreFromFile();
        ToastService.show('Restored from local file', 'success');
        await this.loadMuteList();
      } catch (_error) {
        console.error('Failed to restore from file:', _error);
        ToastService.show('Failed to restore from file', 'error');
      }
    });
  }

  private async handleUnmuteUser(pubkey: string): Promise<void> {
    try {
      // Unmute from both public and private lists atomically
      await this.muteOrch.unmuteUserCompletely(pubkey);
      ToastService.show('User unmuted', 'success');

      // Remove from local list
      this.mutedUsers = this.mutedUsers.filter(u => u.pubkey !== pubkey);
      this.renderMuteList();

      // Refresh feed orchestrators
      const { FeedOrchestrator } = await import('../../services/orchestration/FeedOrchestrator');
      const { NotificationsOrchestrator } = await import('../../services/orchestration/NotificationsOrchestrator');

      const feedOrch = FeedOrchestrator.getInstance();
      const notifOrch = NotificationsOrchestrator.getInstance();

      await Promise.all([
        feedOrch.refreshMutedUsers(),
        notifOrch.refreshMutedUsers()
      ]);

      // Notify timeline to refresh (show unmuted user's posts again)
      const eventBus = EventBus.getInstance();
      eventBus.emit('mute:updated', {});
    } catch (_error) {
      console.error('Failed to unmute user:', _error);
      ToastService.show('Failed to unmute user', 'error');
    }
  }

  private async handleUnmuteThread(eventId: string): Promise<void> {
    try {
      await this.muteOrch.unmuteThread(eventId);
      ToastService.show('Thread unmuted', 'success');

      // Remove from local list
      this.mutedThreads = this.mutedThreads.filter(t => t.eventId !== eventId);
      this.renderMuteList();

      // Notify UI to refresh
      const eventBus = EventBus.getInstance();
      eventBus.emit('mute:thread:updated', { eventId });
      eventBus.emit('mute:updated', {});
    } catch (_error) {
      console.error('Failed to unmute thread:', _error);
      ToastService.show('Failed to unmute thread', 'error');
    }
  }

  public destroy(): void {
    this.container.remove();
  }
}
