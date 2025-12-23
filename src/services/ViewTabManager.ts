/**
 * ViewTabManager - Tab State Management
 *
 * Manages view tabs in secondary content column (scc):
 * - Tab state (Map<tabId, ViewTab>)
 * - View instances
 * - Tab lifecycle (create, destroy, pause, resume)
 * - Duplicate prevention
 * - EventBus integration
 *
 * ONLY used when VIEW_TABS_RIGHT_PANE setting is enabled
 *
 * @service ViewTabManager
 */

import type { ViewType } from './ViewNavigationController';
import type { View } from '../components/views/View';
import { EventBus } from './EventBus';
import { UserProfileService } from './UserProfileService';
import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';
import { decodeNip19 } from './NostrToolsAdapter';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface ViewTab {
  id: string;
  type: ViewType;
  param?: string;
  label: string;
  pubkey?: string;
  profilePicUrl?: string;
  viewInstance: View;
  isActive: boolean;
}

export class ViewTabManager {
  private static instance: ViewTabManager;
  private tabs: Map<string, ViewTab> = new Map();
  private activeTabId: string | null = null;
  private eventBus: EventBus;
  private userProfileService: UserProfileService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;

  private constructor() {
    this.eventBus = EventBus.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
  }

  public static getInstance(): ViewTabManager {
    if (!ViewTabManager.instance) {
      ViewTabManager.instance = new ViewTabManager();
    }
    return ViewTabManager.instance;
  }

  /**
   * Open tab (create new or switch to existing)
   * @param type - View type
   * @param param - View parameter (noteId, npub, etc.)
   * @param replaceActive - Replace active tab instead of creating new
   */
  public async openTab(type: ViewType, param?: string, replaceActive = false): Promise<void> {
    const tabId = this.generateTabId(type, param);

    // Duplicate prevention - switch to existing tab
    if (this.tabs.has(tabId)) {
      this.switchTab(tabId);
      return;
    }

    // Replace active tab (if requested and not System Log)
    if (replaceActive && this.activeTabId && this.activeTabId !== 'system-log') {
      this.closeTab(this.activeTabId);
    }

    // Create view instance
    const viewInstance = await this.createViewInstance(type, param);

    // Generate placeholder label
    const label = this.generatePlaceholderLabel(type);

    // Create tab
    const tab: ViewTab = {
      id: tabId,
      type,
      param,
      label,
      viewInstance,
      isActive: true
    };

    this.tabs.set(tabId, tab);
    this.activeTabId = tabId;

    // Emit event for MainLayout to render tab
    this.eventBus.emit('view-tab:opened', { tab });

    // Extract profile pic from already rendered view (async, waits for profile load)
    setTimeout(() => this.extractProfileDataFromView(tab), 1000);
  }

  /**
   * Close tab and cleanup view instance
   */
  public closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // Destroy view instance
    tab.viewInstance.destroy();

    // Remove from map
    this.tabs.delete(tabId);

    // Switch to another tab if this was active
    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.values());
      this.activeTabId = remaining.length > 0 ? remaining[0].id : 'system-log';
      this.eventBus.emit('view-tab:switched', { tabId: this.activeTabId });
    }

    this.eventBus.emit('view-tab:closed', { tabId });
  }

  /**
   * Switch to tab (pause old, resume new)
   */
  public switchTab(tabId: string): void {
    if (this.activeTabId === tabId) return; // Already active

    // Pause old tab
    const oldTab = this.tabs.get(this.activeTabId || '');
    if (oldTab && typeof oldTab.viewInstance.pause === 'function') {
      oldTab.viewInstance.pause();
    }

    // Resume new tab
    const newTab = this.tabs.get(tabId);
    if (newTab && typeof newTab.viewInstance.resume === 'function') {
      newTab.viewInstance.resume();
    }

    this.activeTabId = tabId;
    this.eventBus.emit('view-tab:switched', { tabId });
  }

  /**
   * Get active tab
   */
  public getActiveTab(): ViewTab | null {
    return this.tabs.get(this.activeTabId || '') || null;
  }

  /**
   * Get all open tabs
   */
  public getOpenTabs(): ViewTab[] {
    return Array.from(this.tabs.values());
  }

  /**
   * Close all tabs (e.g., on logout)
   */
  public closeAllTabs(): void {
    this.tabs.forEach(tab => tab.viewInstance.destroy());
    this.tabs.clear();
    this.activeTabId = 'system-log';
  }

  /**
   * Generate unique tab ID
   */
  private generateTabId(type: ViewType, param?: string): string {
    switch (type) {
      case 'single-note':
        return `snv-${param}`;
      case 'profile':
        return `pv-${param}`;
      case 'notifications':
        return 'nv';
      case 'messages':
        return 'messages';
    }
  }

  /**
   * Create view instance based on type
   */
  private async createViewInstance(type: ViewType, param?: string): Promise<View> {
    switch (type) {
      case 'single-note': {
        const { SingleNoteView } = await import('../components/views/SingleNoteView');
        return new SingleNoteView(param!);
      }
      case 'profile': {
        const { ProfileView } = await import('../components/views/ProfileView');
        return new ProfileView(param!);
      }
      case 'notifications': {
        const { NotificationsView } = await import('../components/views/NotificationsView');
        return new NotificationsView();
      }
      case 'messages': {
        const { MessagesView } = await import('../components/views/MessagesView');
        return new MessagesView();
      }
    }
  }

  /**
   * Generate placeholder label (before async fetch)
   */
  private generatePlaceholderLabel(type: ViewType): string {
    switch (type) {
      case 'single-note':
        return 'Note...';
      case 'profile':
        return 'Profile...';
      case 'notifications':
        return 'Notifications';
      case 'messages':
        return 'Messages';
    }
  }

  /**
   * Extract profile data from already rendered view DOM
   * SingleNoteView/ProfileView already have profile pic rendered
   */
  private extractProfileDataFromView(tab: ViewTab): void {
    const viewElement = tab.viewInstance.getElement();

    // Extract profile pic from rendered NoteHeader
    const profilePic = viewElement.querySelector('.profile-pic--medium, .profile-pic--big') as HTMLImageElement;
    if (profilePic && profilePic.src) {
      tab.profilePicUrl = profilePic.src;

      // Emit update event
      this.eventBus.emit('view-tab:label-updated', {
        tabId: tab.id,
        label: tab.label,
        profilePicUrl: profilePic.src
      });
    }
  }

  /**
   * Fetch and update tab label + profile pic asynchronously
   * Updates placeholder with username/note preview + avatar
   */
  private async fetchAndUpdateLabel(tab: ViewTab): Promise<void> {
    let finalLabel = tab.label;
    let pubkey: string | undefined;
    let profilePicUrl: string | undefined;

    try {
      if (tab.type === 'single-note') {
        // Fetch note event and author profile
        const noteEvent = await this.fetchNoteEvent(tab.param!);
        if (noteEvent) {
          pubkey = noteEvent.pubkey;
          const profile = await this.userProfileService.getUserProfile(noteEvent.pubkey);
          profilePicUrl = profile.picture;
          const preview = noteEvent.content.split('\n')[0].substring(0, 30);
          finalLabel = `@${profile.username || 'unknown'}: ${preview}...`;
        }
      } else if (tab.type === 'profile') {
        // Fetch profile username
        const decoded = decodeNip19(tab.param!);
        if (decoded.type === 'npub') {
          pubkey = decoded.data;
          const profile = await this.userProfileService.getUserProfile(decoded.data);
          profilePicUrl = profile.picture;
          finalLabel = `@${profile.username || 'unknown'}`;
        } else if (decoded.type === 'nprofile') {
          pubkey = decoded.data.pubkey;
          const profile = await this.userProfileService.getUserProfile(decoded.data.pubkey);
          profilePicUrl = profile.picture;
          finalLabel = `@${profile.username || 'unknown'}`;
        }
      }

      // Update tab state
      tab.label = finalLabel;
      tab.pubkey = pubkey;
      tab.profilePicUrl = profilePicUrl;

      // Emit event for MainLayout to update label + profile pic
      this.eventBus.emit('view-tab:label-updated', {
        tabId: tab.id,
        label: finalLabel,
        pubkey,
        profilePicUrl
      });
    } catch (error) {
      console.warn('Failed to fetch tab label:', error);
      // Keep placeholder label on error
    }
  }

  /**
   * Fetch note event by ID
   */
  private async fetchNoteEvent(hexId: string): Promise<NostrEvent | null> {
    const readRelays = this.relayConfig.getReadRelays();

    try {
      const events = await this.transport.fetch(
        readRelays,
        [{ ids: [hexId] }],
        5000 // 5s timeout
      );

      return events.length > 0 ? events[0] : null;
    } catch (error) {
      console.warn('Failed to fetch note event:', error);
      return null;
    }
  }
}
