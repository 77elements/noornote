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
import { EventBus } from '../../services/EventBus';
import { Router } from '../../services/Router';
import { SystemLogger } from '../system/SystemLogger';
import { MuteOrchestrator } from '../../lists/mutes';
import { FeedOrchestrator } from '../../services/orchestration/FeedOrchestrator';
import { NotificationsOrchestrator } from '../../services/orchestration/NotificationsOrchestrator';
import { ToastService } from '../../services/ToastService';
import { AuthGuard } from '../../services/AuthGuard';
import { ContentProcessor } from '../../services/ContentProcessor';
import { QuotedNoteRenderer } from '../../services/QuotedNoteRenderer';
import { replaceMediaPlaceholders } from '../../helpers/renderMediaContent';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { UserIdentity } from '../shared/UserIdentity';
import { npubToHex } from '../../helpers/nip19';

export class ConversationView extends View {
  private container: HTMLElement;
  private dmService: DMService;
  private eventBus: EventBus;
  private router: Router;
  private systemLogger: SystemLogger;
  private contentProcessor: ContentProcessor;
  private quotedNoteRenderer: QuotedNoteRenderer;
  private partnerPubkey: string;
  private messages: DMMessage[] = [];
  private isSending: boolean = false;
  private userIdentity: UserIdentity | null = null;
  private menuOpen: boolean = false;
  private menuElement: HTMLElement | null = null;
  private outsideClickHandler: () => void;
  private subscriptionId: string | null = null;

  constructor(partnerPubkey: string) {
    super();

    this.partnerPubkey = npubToHex(partnerPubkey) || partnerPubkey;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--conversation';
    this.dmService = DMService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.router = Router.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.contentProcessor = ContentProcessor.getInstance();
    this.quotedNoteRenderer = QuotedNoteRenderer.getInstance();
    this.outsideClickHandler = () => this.closeMenu();

    this.render();
    this.loadConversation();

    // Listen for new messages in this conversation
    this.subscriptionId = this.eventBus.on('dm:new-message', (data: { message: DMMessage; conversationWith: string }) => {
      if (data.conversationWith === this.partnerPubkey) {
        this.messages.push(data.message);
        const container = this.messagesContainer;
        if (container) {
          const emptyState = container.querySelector('.conversation-view__empty');
          if (emptyState) emptyState.remove();
          container.appendChild(this.renderMessage(data.message));
        }
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
        <div class="conversation-view__user"></div>
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
          class="textarea conversation-view__textarea"
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

    // Create UserIdentity for partner
    this.userIdentity = new UserIdentity({
      pubkey: this.partnerPubkey,
      size: 'medium',
      showHandle: true,
      clickable: true,
      enableHoverCard: true
    });

    const userContainer = this.container.querySelector('.conversation-view__user');
    if (userContainer) {
      userContainer.appendChild(this.userIdentity.getElement());
    }

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

  private static readonly MUTE_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 2l12 12M6.5 6.5A3 3 0 0 0 10 10m-2-2v4a2 2 0 1 1-4 0V6a2 2 0 0 1 2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  /**
   * Create the mute menu dropdown
   */
  private createMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'note-menu-dropdown';
    menu.style.display = 'none';

    const privateMutesEnabled = MuteOrchestrator.getInstance().isPrivateMutesEnabled();

    menu.innerHTML = privateMutesEnabled
      ? this.createMuteMenuItems(['mute-privately', 'mute-publicly'])
      : this.createMuteMenuItems(['mute-publicly']);

    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest('.note-menu-item') as HTMLElement;
      if (!item) return;

      this.closeMenu();
      this.muteUser(item.dataset.action === 'mute-privately');
    });

    return menu;
  }

  /**
   * Create mute menu item buttons
   */
  private createMuteMenuItems(actions: string[]): string {
    const labels: Record<string, string> = {
      'mute-privately': 'Mute user privately',
      'mute-publicly': actions.length > 1 ? 'Mute user publicly' : 'Mute user'
    };

    return actions.map(action => `
      <button class="note-menu-item note-menu-item--danger" data-action="${action}">
        ${ConversationView.MUTE_ICON}
        ${labels[action]}
      </button>
    `).join('');
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
      // Mark conversation as read
      await this.dmService.markAsRead(this.partnerPubkey);

      // Load messages and sort oldest first (newest at bottom)
      this.messages = await this.dmService.getMessages(this.partnerPubkey);
      this.messages.sort((a, b) => a.createdAt - b.createdAt);

      // Render messages and scroll to bottom
      this.renderMessages();
      this.scrollToBottom();
    } catch (_error) {
      this.systemLogger.error('ConversationView', 'Failed to load conversation:', _error);
      this.renderError();
    }
  }

  /**
   * Get messages container element
   */
  private get messagesContainer(): HTMLElement | null {
    return this.container.querySelector('.conversation-view__messages');
  }

  /**
   * Scroll messages container to bottom
   */
  private scrollToBottom(): void {
    const container = this.messagesContainer;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  /**
   * Render messages list (DOM-based for proper content processing)
   */
  private renderMessages(): void {
    const container = this.messagesContainer;
    if (!container) return;

    if (this.messages.length === 0) {
      container.innerHTML = `
        <div class="conversation-view__empty">
          <p>No messages yet</p>
          <p class="text-alpha-medium">Send a message to start the conversation</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    this.messages.forEach(msg => {
      const messageEl = this.renderMessage(msg);
      container.appendChild(messageEl);
    });
  }

  /**
   * Render a single message with full content processing
   * Handles: links, media, npub mentions, hashtags, quoted notes
   */
  private renderMessage(message: DMMessage): HTMLElement {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${message.isMine ? 'message--own' : 'message--other'}`;

    // Process content through ContentProcessor
    const processed = this.contentProcessor.processContent(message.content);

    // Replace media placeholders with actual media elements
    const htmlWithMedia = replaceMediaPlaceholders(
      processed.html,
      processed.media,
      false, // isNSFW - DMs don't have content warnings
      message.id,
      message.isMine ? 'self' : this.partnerPubkey
    );

    messageEl.innerHTML = `
      <div class="message__content">${htmlWithMedia}</div>
      <div class="message__quotes"></div>
      <div class="message__meta">
        <span class="message__time">${this.formatTime(message.createdAt)}</span>
      </div>
    `;

    // Render quoted notes if any
    if (processed.quotedReferences.length > 0) {
      const quotesContainer = messageEl.querySelector('.message__quotes');
      if (quotesContainer) {
        this.quotedNoteRenderer.renderQuotedNotes(processed.quotedReferences, quotesContainer, false);
      }
    }

    // Setup hover cards for user mentions
    setupUserMentionHandlers(messageEl);

    return messageEl;
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
   * Render error state
   */
  private renderError(): void {
    const container = this.messagesContainer;
    if (!container) return;

    container.innerHTML = `
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
    if (this.userIdentity) {
      this.userIdentity.destroy();
      this.userIdentity = null;
    }
  }
}
