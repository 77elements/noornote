/**
 * ConversationView Component
 * NIP-17 Private Direct Messages - Single Conversation Thread
 *
 * @view ConversationView
 * @purpose Display message thread with a single user
 * @used-by App.ts via Router
 */

import { View } from './View';
import type { DMsModuleApi } from '../../modules/dms/contracts';
import type { DMMessage } from '../../services/dm/DMStore';
import { TypedEventBus } from '../../core/TypedEventBus';
import { Router } from '../../services/Router';
import { SystemLogger } from '../../services/SystemLogger';
import { MuteOrchestrator } from '../../lists/mutes';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { TimelineModuleApi } from '../../modules/timeline/contracts';
import type { NotificationsModuleApi } from '../../modules/notifications/contracts';
import { ToastService } from '../../services/ToastService';
import { AuthGuard } from '../../services/AuthGuard';
import { ContentProcessor } from '../../services/ContentProcessor';
import { QuotedNoteRenderer } from '../ui/note-rendering/QuotedNoteRenderer';
import { replaceMediaPlaceholders } from '../../helpers/renderMediaContent';
import { replaceBolt11Placeholders } from '../../helpers/renderBolt11';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { UserIdentity } from '../shared/UserIdentity';
import { npubToHex } from '../../helpers/nip19';

export class ConversationView extends View {
  private container: HTMLElement;
  private _dmsApi?: DMsModuleApi | null;
  private get dmsApi(): DMsModuleApi | null {
    return this._dmsApi ??= ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
  }
  private eventBus: TypedEventBus;
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
  private fetchCompleteSubId: string | null = null;

  constructor(partnerPubkey: string) {
    super();

    this.partnerPubkey = npubToHex(partnerPubkey) || partnerPubkey;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--conversation';
    this.eventBus = TypedEventBus.getInstance();
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
        // A sent message can be emitted twice in a race: once optimistically and
        // once when its own gift-wrap echoes back from the relay. Both carry the
        // same rumor id (and wrapId), so ignore one we've already rendered.
        const incoming = data.message;
        const isDuplicate = this.messages.some(m =>
          m.id === incoming.id || (!!incoming.wrapId && m.wrapId === incoming.wrapId)
        );
        if (isDuplicate) return;

        this.messages.push(incoming);
        const container = this.messagesContainer;
        if (container) {
          const emptyState = container.querySelector('.conversation-view__empty');
          if (emptyState) emptyState.remove();
          container.appendChild(this.renderMessage(data.message));
        }
        this.scrollToBottom();
      }
    });

    // On reload this view can mount before DMService has populated the store
    // (start() runs after routing), so the initial load reads an empty store and
    // shows "No messages yet". Reload once the historical fetch completes —
    // guarded to the still-empty case so an active conversation isn't disrupted
    // by the periodic background sync.
    this.fetchCompleteSubId = this.eventBus.on('dm:fetch-complete', () => {
      if (this.messages.length === 0) {
        this.loadConversation();
      }
    });
  }

  /**
   * Render the conversation view structure
   */
  private render(): void {
    this.container.innerHTML = `
      <div class="conversation-view__header">
        <button class="btn btn--square" data-action="back">
          <span class="chevron-left"></span>
        </button>
        <div class="conversation-view__user"></div>
        <button class="note-menu-trigger conversation-view__menu-trigger" aria-label="User options">
          <svg width="16" height="16"><use href="#icon-menu-dots"/></svg>
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
          <svg width="20" height="20"><use href="#icon-send"/></svg>
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
    const backBtn = this.container.querySelector('[data-action="back"]');
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

  private static readonly MUTE_ICON = `<svg width="16" height="16"><use href="#icon-mute"/></svg>`;

  /**
   * Create the mute menu dropdown
   */
  private createMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'note-menu-dropdown';
    menu.style.display = 'none';

    const privateMutesEnabled = MuteOrchestrator.getInstance().isPrivateMutesEnabled();

    const muteItems = privateMutesEnabled
      ? this.createMuteMenuItems(['mute-privately', 'mute-publicly'])
      : this.createMuteMenuItems(['mute-publicly']);

    menu.innerHTML = muteItems + `
      <button class="note-menu-item note-menu-item--danger" data-action="delete-conversation">
        <svg width="16" height="16"><use href="#icon-trash"/></svg>
        Delete conversation
      </button>
    `;

    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest('.note-menu-item') as HTMLElement;
      if (!item) return;

      this.closeMenu();
      if (item.dataset.action === 'delete-conversation') {
        this.confirmDelete();
      } else {
        this.muteUser(item.dataset.action === 'mute-privately');
      }
    });

    return menu;
  }

  /**
   * Confirm + locally soft-delete this conversation, then return to the list.
   */
  private async confirmDelete(): Promise<void> {
    const { ModalService } = await import('../../services/ModalService');
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete conversation',
      message: 'Delete this conversation? It is removed only from this device.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      confirmDestructive: true,
    });
    if (!confirmed) return;

    await this.dmsApi?.deleteConversation(this.partnerPubkey);
    ToastService.show('Conversation deleted', 'success');
    this.router.navigate('/messages');
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
      const loader = ModuleLoader.getInstance();
      const timelineApi = loader.getApi<TimelineModuleApi>('timeline');
      const notifApi = loader.getApi<NotificationsModuleApi>('notifications');
      await Promise.all([
        timelineApi?.refreshMutedUsers() ?? Promise.resolve(),
        notifApi?.refreshMutedUsers() ?? Promise.resolve()
      ]);

      // Notify that mute list was updated
      this.eventBus.emit('mute:updated');

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
      await this.dmsApi?.markAsRead(this.partnerPubkey);

      // Load messages and sort oldest first (newest at bottom)
      this.messages = await this.dmsApi?.getMessages(this.partnerPubkey) ?? [];
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
    let htmlWithMedia = replaceMediaPlaceholders(
      processed.html,
      processed.media,
      false, // isNSFW - DMs don't have content warnings
      message.id,
      message.isMine ? 'self' : this.partnerPubkey
    );
    htmlWithMedia = replaceBolt11Placeholders(htmlWithMedia, processed.bolt11Invoices);

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

    // Clear the composer immediately so the message doesn't linger in the input
    // while the send round-trips (gift-wrap + relay publish can take 1-2s).
    // Restore the text if the send fails.
    textarea.value = '';
    textarea.style.height = 'auto';

    try {
      const success = await this.dmsApi?.sendMessage(this.partnerPubkey, content) ?? false;

      if (success) {
        this.systemLogger.info('ConversationView', 'Message sent');
      } else {
        textarea.value = content;
        this.systemLogger.error('ConversationView', 'Failed to send message');
        ToastService.show('Could not send message — please try again', 'error');
      }
    } catch (_error) {
      textarea.value = content;
      this.systemLogger.error('ConversationView', 'Error sending message:', _error);
      const timedOut = _error instanceof Error && _error.name === 'SignerTimeoutError';
      ToastService.show(
        timedOut ? 'Signer did not respond — message not sent' : 'Could not send message — please try again',
        'error'
      );
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
    if (this.fetchCompleteSubId) {
      this.eventBus.off(this.fetchCompleteSubId);
      this.fetchCompleteSubId = null;
    }
    if (this.userIdentity) {
      this.userIdentity.destroy();
      this.userIdentity = null;
    }
  }
}
