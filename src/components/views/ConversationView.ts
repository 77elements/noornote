/**
 * ConversationView Component
 * NIP-17 Private Direct Messages - Single Conversation Thread
 *
 * @view ConversationView
 * @purpose Display message thread with a single user
 * @used-by App.ts via Router
 */

import { View } from './View';
import { DMService } from '../../services/dm/DMService';
import type { DMMessage } from '../../services/dm/DMStore';
import { UserProfileService } from '../../services/UserProfileService';
import { EventBus } from '../../services/EventBus';
import { Router } from '../../services/Router';
import { SystemLogger } from '../system/SystemLogger';
import { MuteOrchestrator } from '../../services/orchestration/MuteOrchestrator';
import { FeedOrchestrator } from '../../services/orchestration/FeedOrchestrator';
import { NotificationsOrchestrator } from '../../services/orchestration/NotificationsOrchestrator';
import { ToastService } from '../../services/ToastService';
import { AuthGuard } from '../../services/AuthGuard';
import { escapeHtml } from '../../helpers/escapeHtml';

export class ConversationView extends View {
  private container: HTMLElement;
  private dmService: DMService;
  private userProfileService: UserProfileService;
  private eventBus: EventBus;
  private router: Router;
  private systemLogger: SystemLogger;
  private partnerPubkey: string;
  private messages: DMMessage[] = [];
  private isSending: boolean = false;
  private partnerProfile: { displayName: string; avatarUrl: string } | null = null;
  private menuOpen: boolean = false;
  private menuElement: HTMLElement | null = null;
  private outsideClickHandler: () => void;
  private subscriptionId: string | null = null;

  constructor(partnerPubkey: string) {
    super();

    this.partnerPubkey = partnerPubkey;
    this.container = document.createElement('div');
    this.container.className = 'conversation-view';
    this.dmService = DMService.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.router = Router.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.outsideClickHandler = () => this.closeMenu();

    this.render();
    this.loadConversation();

    // Listen for new messages in this conversation
    this.subscriptionId = this.eventBus.on('dm:new-message', (data: { message: DMMessage; conversationWith: string }) => {
      if (data.conversationWith === this.partnerPubkey) {
        this.messages.push(data.message);
        this.renderMessages();
        this.scrollToBottom();
      }
    });
  }

  /**
   * Render the conversation view structure
   */
  private render(): void {
    this.container.innerHTML = `
      <div class="conversation-view__header">
        <button class="conversation-view__back-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <div class="conversation-view__user">
          <div class="conversation-view__avatar"></div>
          <span class="conversation-view__name">Loading...</span>
        </div>
        <button class="note-menu-trigger conversation-view__menu-trigger" aria-label="User options">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="2" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="14" r="1.5" />
          </svg>
        </button>
      </div>
      <div class="conversation-view__messages">
        <div class="conversation-view__loading">Loading messages...</div>
      </div>
      <div class="conversation-view__input">
        <textarea
          class="conversation-view__textarea"
          placeholder="Type a message..."
          rows="1"
        ></textarea>
        <button class="btn btn--medium conversation-view__send-btn" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    `;

    this.setupEventListeners();
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Back button
    const backBtn = this.container.querySelector('.conversation-view__back-btn');
    backBtn?.addEventListener('click', () => {
      this.router.navigate('/messages');
    });

    // Menu trigger
    const menuTrigger = this.container.querySelector('.conversation-view__menu-trigger');
    menuTrigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // Textarea auto-resize and send button enable
    const textarea = this.container.querySelector('.conversation-view__textarea') as HTMLTextAreaElement;
    const sendBtn = this.container.querySelector('.conversation-view__send-btn') as HTMLButtonElement;

    textarea?.addEventListener('input', () => {
      // Auto-resize
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';

      // Enable/disable send button
      sendBtn.disabled = !textarea.value.trim();
    });

    // Send on Enter (without Shift)
    textarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim()) {
          this.sendMessage();
        }
      }
    });

    // Send button click
    sendBtn?.addEventListener('click', () => {
      if (!this.isSending && textarea.value.trim()) {
        this.sendMessage();
      }
    });
  }

  /**
   * Toggle menu visibility
   */
  private toggleMenu(): void {
    if (this.menuOpen) {
      this.closeMenu();
    } else {
      this.openMenu();
    }
  }

  /**
   * Open mute menu
   */
  private openMenu(): void {
    // Create menu if it doesn't exist
    if (!this.menuElement) {
      this.menuElement = this.createMenu();
      document.body.appendChild(this.menuElement);
    }

    // Position menu
    const trigger = this.container.querySelector('.conversation-view__menu-trigger');
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      this.menuElement.style.top = `${rect.bottom + 4}px`;
      this.menuElement.style.left = `${rect.right - 200}px`; // Align to right edge
    }

    this.menuElement.style.display = 'block';
    this.menuOpen = true;

    // Add outside click listener
    setTimeout(() => {
      document.addEventListener('click', this.outsideClickHandler);
    }, 0);
  }

  /**
   * Close mute menu
   */
  private closeMenu(): void {
    if (this.menuElement) {
      this.menuElement.style.display = 'none';
    }
    this.menuOpen = false;
    document.removeEventListener('click', this.outsideClickHandler);
  }

  /**
   * Create the mute menu dropdown
   */
  private createMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'note-menu-dropdown';
    menu.style.display = 'none';

    const muteOrch = MuteOrchestrator.getInstance();
    const privateMutesEnabled = muteOrch.isPrivateMutesEnabled();

    const muteIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 2l12 12M6.5 6.5A3 3 0 0 0 10 10m-2-2v4a2 2 0 1 1-4 0V6a2 2 0 0 1 2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    menu.innerHTML = privateMutesEnabled ? `
      <button class="note-menu-item note-menu-item--danger" data-action="mute-privately">
        ${muteIcon}
        Mute user privately
      </button>
      <button class="note-menu-item note-menu-item--danger" data-action="mute-publicly">
        ${muteIcon}
        Mute user publicly
      </button>
    ` : `
      <button class="note-menu-item note-menu-item--danger" data-action="mute-publicly">
        ${muteIcon}
        Mute user
      </button>
    `;

    // Setup menu item click handlers
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const item = target.closest('.note-menu-item') as HTMLElement;
      if (!item) return;

      const action = item.dataset.action;
      this.closeMenu();

      if (action === 'mute-privately') {
        this.muteUser(true);
      } else if (action === 'mute-publicly') {
        this.muteUser(false);
      }
    });

    return menu;
  }

  /**
   * Mute the conversation partner
   */
  private async muteUser(isPrivate: boolean): Promise<void> {
    if (!AuthGuard.requireAuth('mute user')) {
      return;
    }

    const muteOrch = MuteOrchestrator.getInstance();

    try {
      await muteOrch.muteUser(this.partnerPubkey, isPrivate);
      ToastService.show(`User muted ${isPrivate ? 'privately' : 'publicly'}`, 'success');

      // Refresh muted users in orchestrators
      const feedOrch = FeedOrchestrator.getInstance();
      const notifOrch = NotificationsOrchestrator.getInstance();
      await Promise.all([
        feedOrch.refreshMutedUsers(),
        notifOrch.refreshMutedUsers()
      ]);

      // Notify that mute list was updated
      this.eventBus.emit('mute:updated', {});

      // Navigate back to messages list
      this.router.navigate('/messages');
    } catch (_error) {
      this.systemLogger.error('ConversationView', `Failed to mute user: ${_error}`);
      ToastService.show('Failed to mute user', 'error');
    }
  }

  /**
   * Load conversation data
   */
  private async loadConversation(): Promise<void> {
    try {
      // Load partner profile
      const profile = await this.userProfileService.getUserProfile(this.partnerPubkey);
      this.partnerProfile = {
        displayName: profile?.display_name || profile?.name || this.partnerPubkey.slice(0, 8) + '...',
        avatarUrl: profile?.picture || ''
      };

      // Update header
      this.updateHeader();

      // Mark conversation as read
      await this.dmService.markAsRead(this.partnerPubkey);

      // Load messages
      this.messages = await this.dmService.getMessages(this.partnerPubkey);

      // Render messages
      this.renderMessages();
      this.scrollToBottom();
    } catch (_error) {
      this.systemLogger.error('ConversationView', 'Failed to load conversation:', _error);
      this.renderError();
    }
  }

  /**
   * Update header with partner info
   */
  private updateHeader(): void {
    if (!this.partnerProfile) return;

    const avatarEl = this.container.querySelector('.conversation-view__avatar');
    const nameEl = this.container.querySelector('.conversation-view__name');

    if (avatarEl) {
      if (this.partnerProfile.avatarUrl) {
        avatarEl.innerHTML = `<img src="${this.partnerProfile.avatarUrl}" alt="${this.partnerProfile.displayName}" />`;
      } else {
        avatarEl.innerHTML = `<div class="avatar-placeholder">${this.partnerProfile.displayName.charAt(0).toUpperCase()}</div>`;
      }
    }

    if (nameEl) {
      nameEl.textContent = this.partnerProfile.displayName;
    }
  }

  /**
   * Render messages list
   */
  private renderMessages(): void {
    const messagesContainer = this.container.querySelector('.conversation-view__messages');
    if (!messagesContainer) return;

    if (this.messages.length === 0) {
      messagesContainer.innerHTML = `
        <div class="conversation-view__empty">
          <p>No messages yet</p>
          <p class="text-muted">Send a message to start the conversation</p>
        </div>
      `;
      return;
    }

    messagesContainer.innerHTML = this.messages.map(msg => this.renderMessage(msg)).join('');
  }

  /**
   * Render a single message
   */
  private renderMessage(message: DMMessage): string {
    const isOwn = message.isMine;
    const time = this.formatTime(message.createdAt);

    return `
      <div class="message ${isOwn ? 'message--own' : 'message--other'}">
        <div class="message__content">${escapeHtml(message.content)}</div>
        <div class="message__meta">
          <span class="message__time">${time}</span>
        </div>
      </div>
    `;
  }

  /**
   * Send a message
   */
  private async sendMessage(): Promise<void> {
    const textarea = this.container.querySelector('.conversation-view__textarea') as HTMLTextAreaElement;
    const sendBtn = this.container.querySelector('.conversation-view__send-btn') as HTMLButtonElement;

    const content = textarea.value.trim();
    if (!content || this.isSending) return;

    this.isSending = true;
    sendBtn.disabled = true;

    try {
      const success = await this.dmService.sendMessage(this.partnerPubkey, content);

      if (success) {
        // Clear input
        textarea.value = '';
        textarea.style.height = 'auto';

        this.systemLogger.info('ConversationView', 'Message sent');
      } else {
        this.systemLogger.error('ConversationView', 'Failed to send message');
      }
    } catch (_error) {
      this.systemLogger.error('ConversationView', 'Error sending message:', _error);
    } finally {
      this.isSending = false;
      sendBtn.disabled = !textarea.value.trim();
    }
  }

  /**
   * Scroll to bottom of messages
   */
  private scrollToBottom(): void {
    const messagesContainer = this.container.querySelector('.conversation-view__messages');
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  /**
   * Render error state
   */
  private renderError(): void {
    const messagesContainer = this.container.querySelector('.conversation-view__messages');
    if (!messagesContainer) return;

    messagesContainer.innerHTML = `
      <div class="conversation-view__error">
        <p>Failed to load messages</p>
        <button class="btn btn--medium" onclick="location.reload()">Retry</button>
      </div>
    `;
  }

  /**
   * Format timestamp as time (US format with year, line break before time)
   */
  private formatTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    if (isToday) {
      return timeStr;
    }

    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    return `${dateStr}<br>${timeStr}`;
  }

  /**
   * Get container element for mounting
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup on unmount
   */
  public destroy(): void {
    this.closeMenu();
    if (this.menuElement) {
      this.menuElement.remove();
      this.menuElement = null;
    }
    if (this.subscriptionId) {
      this.eventBus.off(this.subscriptionId);
      this.subscriptionId = null;
    }
  }
}
