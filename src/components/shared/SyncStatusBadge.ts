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
            <svg class="sync-status-badge__icon sync-status-badge__icon--spinning" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            <span class="sync-status-badge__text">Syncing follow list...</span>
          </div>
        `;

      case 'synced':
        const timeAgo = data.timestamp ? formatTimeAgo(data.timestamp) : '';
        const countText = data.count !== undefined ? ` (${data.count} follows)` : '';
        return `
          <div class="sync-status-badge sync-status-badge--synced">
            <svg class="sync-status-badge__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span class="sync-status-badge__text">Synced ${timeAgo}${countText}</span>
          </div>
        `;

      case 'error':
        const errorText = data.error ? `: ${data.error}` : '';
        return `
          <div class="sync-status-badge sync-status-badge--error">
            <svg class="sync-status-badge__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span class="sync-status-badge__text">Sync failed${errorText}</span>
          </div>
        `;

      default:
        return '';
    }
  }


  /**
   * Subscribe to AppState for automatic updates
   */
  public subscribeToSyncStatus(callback?: (data: SyncStatusData) => void): void {
    // Subscribe to followlist sync state in AppState
    this.unsubscribe = this.appState.subscribe('user', (userState) => {
      // We'll add syncStatus to UserState in next step
      const syncData = (userState as any).syncStatus as SyncStatusData | undefined;

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
