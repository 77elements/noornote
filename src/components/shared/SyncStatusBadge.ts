/**
 * SyncStatusBadge Component
 * Displays sync status for follow list (and later: profile, relays)
 *
 * States:
 * - Syncing: "⟳ Syncing..."
 * - Synced: "✓ Synced 2m ago"
 * - Error: "✗ Sync failed"
 * - Idle: (hidden)
 *
 * @component SyncStatusBadge
 * @used-by SettingsView
 */

import { AppState } from '../../services/AppState';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

export interface SyncStatusData {
  status: SyncStatus;
  count?: number;
  timestamp?: number;
  error?: string;
}

export class SyncStatusBadge {
  private container: HTMLElement;
  private appState: AppState;
  private unsubscribe: (() => void) | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.appState = AppState.getInstance();
  }

  /**
   * Render the badge
   */
  public render(data: SyncStatusData): void {
    // Clear existing hide timeout
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    // Don't show badge when idle
    if (data.status === 'idle') {
      this.container.innerHTML = '';
      return;
    }

    const badge = this.createBadge(data);
    this.container.innerHTML = badge;

    // Auto-hide "synced" badge after 5 seconds
    if (data.status === 'synced') {
      this.hideTimeout = setTimeout(() => {
        this.container.innerHTML = '';
        this.hideTimeout = null;
      }, 5000);
    }
  }

  /**
   * Create badge HTML based on status
   */
  private createBadge(data: SyncStatusData): string {
    switch (data.status) {
      case 'syncing':
        return `
          <div class="sync-status-badge sync-status-badge--syncing">
            <svg class="sync-status-badge__icon sync-status-badge__icon--spinning" width="14" height="14"><use href="#icon-syncing"/></svg>
            <span class="sync-status-badge__text">Syncing follow list...</span>
          </div>
        `;

      case 'synced': {
        const timeAgo = data.timestamp ? formatTimeAgo(data.timestamp) : '';
        const countText =
          data.count !== undefined ? ` (${data.count} follows)` : '';
        return `
          <div class="sync-status-badge sync-status-badge--synced">
            <svg class="sync-status-badge__icon" width="14" height="14"><use href="#icon-synced"/></svg>
            <span class="sync-status-badge__text">Synced ${timeAgo}${countText}</span>
          </div>
        `;
      }

      case 'error': {
        const errorText = data.error ? `: ${data.error}` : '';
        return `
          <div class="sync-status-badge sync-status-badge--error">
            <svg class="sync-status-badge__icon" width="14" height="14"><use href="#icon-error-circle"/></svg>
            <span class="sync-status-badge__text">Sync failed${errorText}</span>
          </div>
        `;
      }

      default:
        return '';
    }
  }

  /**
   * Subscribe to AppState for automatic updates
   */
  public subscribeToSyncStatus(
    callback?: (data: SyncStatusData) => void
  ): void {
    // Subscribe to followlist sync state in AppState
    this.unsubscribe = this.appState.subscribe('user', userState => {
      // We'll add syncStatus to UserState in next step
      const syncData = (userState as { syncStatus?: SyncStatusData })
        .syncStatus as SyncStatusData | undefined;

      if (syncData) {
        this.render(syncData);
        if (callback) callback(syncData);
      }
    });
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    this.container.innerHTML = '';
  }
}
