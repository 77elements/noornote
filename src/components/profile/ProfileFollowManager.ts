/**
 * ProfileFollowManager
 * Manages follow/unfollow functionality for profile views
 * Handles both public and private follows (NIP-51)
 *
 * @manager ProfileFollow
 * @purpose Isolate follow/unfollow logic from ProfileView
 * @used-by ProfileView
 */

import { AuthService } from '../../services/AuthService';
import { FollowListOrchestrator } from '../../services/orchestration/FollowListOrchestrator';
import { FollowStorageAdapter } from '../../services/sync/adapters/FollowStorageAdapter';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import type { FollowItem } from '../../services/storage/FollowFileStorage';

export interface FollowState {
  isFollowing: boolean;
  followingCount: number;
}

export class ProfileFollowManager {
  private authService: AuthService;
  private followListOrch: FollowListOrchestrator;
  private followAdapter: FollowStorageAdapter;
  private eventBus: EventBus;
  private targetPubkey: string;
  private isFollowing: boolean = false;

  constructor(targetPubkey: string) {
    this.targetPubkey = targetPubkey;
    this.authService = AuthService.getInstance();
    this.followListOrch = FollowListOrchestrator.getInstance();
    this.followAdapter = new FollowStorageAdapter();
    this.eventBus = EventBus.getInstance();
  }

  /**
   * Check if current user follows the target profile
   * Reads from browserItems (localStorage)
   */
  public async checkFollowStatus(): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser || this.targetPubkey === currentUser.pubkey) {
      return false;
    }

    // Read from browserItems (localStorage)
    let browserItems = this.followAdapter.getBrowserItems();

    // If browserItems is empty, initialize from files (first load)
    if (browserItems.length === 0) {
      const fileItems = await this.followAdapter.getFileItems();
      if (fileItems.length > 0) {
        this.followAdapter.setBrowserItems(fileItems);
        browserItems = fileItems;
      }
    }

    this.isFollowing = browserItems.some(item => item.pubkey === this.targetPubkey);
    return this.isFollowing;
  }

  /**
   * Get current follow status
   */
  public getFollowStatus(): boolean {
    return this.isFollowing;
  }

  /**
   * Render follow button HTML
   */
  public renderFollowButton(): string {
    const currentUser = this.authService.getCurrentUser();

    // Don't show button if not logged in or viewing own profile
    if (!currentUser || this.targetPubkey === currentUser.pubkey) {
      return '';
    }

    if (this.isFollowing) {
      return `
        <button class="btn btn--passive follow-btn" data-action="unfollow">
          Disconnect
        </button>
      `;
    } else {
      // Check if NIP-51 private follows are enabled
      const isPrivateFollowsEnabled = this.followListOrch.isPrivateFollowsEnabled();

      if (isPrivateFollowsEnabled) {
        // Show dropdown with public/private options
        return `
          <div class="follow-dropdown-container">
            <button class="btn follow-btn-dropdown" id="follow-btn-dropdown">
              Connect 🫂
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: 4px;">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
            <div class="follow-dropdown-menu" id="follow-dropdown-menu">
              <button class="follow-dropdown-item" data-action="follow-public">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                </svg>
                Connect publicly
              </button>
              <button class="follow-dropdown-item" data-action="follow-private">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                Connect privately
              </button>
            </div>
          </div>
        `;
      } else {
        // Show simple Connect button (no dropdown)
        return `
          <button class="btn follow-btn" data-action="follow">
            Connect 🫂
          </button>
        `;
      }
    }
  }

  /**
   * Setup follow button event handlers
   */
  public setupFollowButton(container: HTMLElement, onStateChange: () => void): void {
    // Guard: Check if container exists and is in DOM (might be removed if HoverCard is hidden)
    if (!container || !container.isConnected) return;

    // Handle simple unfollow button
    const unfollowBtn = container.querySelector('.follow-btn[data-action="unfollow"]');
    if (unfollowBtn) {
      unfollowBtn.addEventListener('click', async () => {
        await this.handleUnfollow(container, onStateChange);
      });
      return;
    }

    // Handle simple follow button (when NIP-51 is disabled)
    const simpleFollowBtn = container.querySelector('.follow-btn[data-action="follow"]');
    if (simpleFollowBtn) {
      simpleFollowBtn.addEventListener('click', async () => {
        await this.handleFollow(container, 'public', onStateChange);
      });
      return;
    }

    // Handle follow dropdown (when NIP-51 is enabled)
    const dropdownBtn = container.querySelector('#follow-btn-dropdown');
    const dropdownMenu = container.querySelector('#follow-dropdown-menu');

    if (!dropdownBtn || !dropdownMenu) return;

    // Toggle dropdown on button click
    dropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle('show');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      dropdownMenu.classList.remove('show');
    });

    // Handle dropdown item clicks
    const dropdownItems = container.querySelectorAll('.follow-dropdown-item');
    dropdownItems.forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = (item as HTMLElement).dataset.action;

        dropdownMenu.classList.remove('show');

        if (action === 'follow-public') {
          await this.handleFollow(container, 'public', onStateChange);
        } else if (action === 'follow-private') {
          await this.handleFollow(container, 'private', onStateChange);
        }
      });
    });
  }

  /**
   * Handle follow action
   * Writes to browserItems (localStorage) only - use "Save to File" to persist
   */
  private async handleFollow(container: HTMLElement, type: 'public' | 'private', onStateChange: () => void): Promise<void> {
    // Guard: Check if container exists and is in DOM
    if (!container || !container.isConnected) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    // Check if sync is in progress (Race Condition Prevention)
    if (this.followListOrch.isSyncInProgress()) {
      ToastService.show('Still syncing follow list. Please wait.', 'warning');
      return;
    }

    // Try to find dropdown button (NIP-51 enabled) or simple button (NIP-51 disabled)
    const dropdownBtn = container.querySelector('#follow-btn-dropdown') as HTMLButtonElement;
    const simpleBtn = container.querySelector('.follow-btn[data-action="follow"]') as HTMLButtonElement;
    const followBtn = dropdownBtn || simpleBtn;

    if (!followBtn) return;

    const originalHTML = followBtn.innerHTML;

    try {
      // Show loading state
      followBtn.disabled = true;
      followBtn.textContent = 'Connecting...';

      // Add to browserItems (localStorage) with isPrivate flag
      const currentItems = this.followAdapter.getBrowserItems();

      if (!currentItems.some(item => item.pubkey === this.targetPubkey)) {
        const newItem: FollowItem = {
          id: this.targetPubkey,
          pubkey: this.targetPubkey,
          addedAt: Math.floor(Date.now() / 1000),
          isPrivate: type === 'private'  // Store private status in browser item
        };
        currentItems.push(newItem);
        this.followAdapter.setBrowserItems(currentItems);
      }

      // Update internal state
      this.isFollowing = true;

      // Emit event to update other components
      this.eventBus.emit('follow:updated', {});

      // Trigger callback to update UI
      onStateChange();

      // Show success toast
      const followType = type === 'public' ? 'publicly' : 'privately';
      ToastService.show(`Connected ${followType} (local)`, 'success');
    } catch (error) {
      console.error('Failed to connect:', error);
      ToastService.show('Failed to connect to user', 'error');

      // Reset button state
      followBtn.disabled = false;
      followBtn.innerHTML = originalHTML;

      // Re-bind listeners
      this.setupFollowButton(container, onStateChange);
    }
  }

  /**
   * Handle unfollow action
   * Writes to browserItems (localStorage) only - use "Save to File" to persist
   */
  private async handleUnfollow(container: HTMLElement, onStateChange: () => void): Promise<void> {
    // Guard: Check if container exists and is in DOM
    if (!container || !container.isConnected) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    // Check if sync is in progress (Race Condition Prevention)
    if (this.followListOrch.isSyncInProgress()) {
      ToastService.show('Still syncing follow list. Please wait.', 'warning');
      return;
    }

    const followBtn = container.querySelector('.follow-btn') as HTMLButtonElement;
    if (!followBtn) return;

    try {
      // Show loading state
      followBtn.disabled = true;
      followBtn.textContent = 'Disconnecting...';

      // Remove from browserItems (localStorage) only
      const currentItems = this.followAdapter.getBrowserItems();
      const updatedItems = currentItems.filter(item => item.pubkey !== this.targetPubkey);
      this.followAdapter.setBrowserItems(updatedItems);

      // Update internal state
      this.isFollowing = false;

      // Emit event to update other components
      this.eventBus.emit('follow:updated', {});

      // Trigger callback to update UI
      onStateChange();

      // Show success toast
      ToastService.show('Disconnected successfully (local)', 'success');
    } catch (error) {
      console.error('Failed to disconnect:', error);
      ToastService.show('Failed to disconnect from user', 'error');

      // Reset button state
      followBtn.disabled = false;
      followBtn.textContent = 'Disconnect';
    }
  }
}
