/**
 * MessagesView Component
 * NIP-17 Private Direct Messages - Conversations List
 *
 * @view MessagesView
 * @purpose Display list of DM conversations with Known/Unknown tabs
 * @used-by App.ts via Router
 */

import { errMessage } from '../../helpers/errorMessage';
import { escapeHtmlAttr } from '../../helpers/escapeHtml';
import { _, tn } from '../../i18n';
import { View } from './View';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { DMsModuleApi } from '../../modules/dms/contracts';
import type { DMConversation } from '../../services/dm/DMStore';
import { buildConversationItem } from '../ui/ConversationItem';
import { TypedEventBus } from '../../core/TypedEventBus';
import { Router } from '../../services/Router';
import { SystemLogger } from '../../services/SystemLogger';
import { diagLog } from '../../services/DiagnosticLogger';
import { DMToastNotifier } from '../../services/dm/DMToastNotifier';
import { Tooltip } from '../ui/Tooltip';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { ToastService } from '../../services/ToastService';
import {
  setupTabClickHandlers,
  switchTabWithContent,
} from '../../helpers/TabsHelper';
import { ProgressBarHelper } from '../../helpers/ProgressBarHelper';
import { DMComposeModal } from '../modals/DMComposeModal';

const BATCH_SIZE = 15;

/** Session-persisted last active tab — back-navigation from a conversation
 *  remounts this view and must land in the tab the user came from. */
const TAB_STORAGE_KEY = 'noornote_messages_tab';

type TabFilter = 'known' | 'unknown';

function readInitialTab(): TabFilter {
  try {
    return sessionStorage.getItem(TAB_STORAGE_KEY) === 'unknown'
      ? 'unknown'
      : 'known';
  } catch {
    return 'known';
  }
}

export class MessagesView extends View {
  private container: HTMLElement;
  private _dmsApi?: DMsModuleApi | null;
  private get dmsApi(): DMsModuleApi | null {
    return (this._dmsApi ??=
      ModuleLoader.getInstance().getApi<DMsModuleApi>('dms'));
  }
  private eventBus: TypedEventBus;
  private router: Router;
  private systemLogger: SystemLogger;
  private conversations: DMConversation[] = [];
  private isLoading: boolean = false;
  private currentOffset: number = 0;
  private hasMoreConversations: boolean = true;
  private infiniteScroll: InfiniteScroll;
  private menuOpen: boolean = false;
  private outsideClickHandler: () => void;
  private activeTab: TabFilter = readInitialTab();
  private subscriptionIds: string[] = [];
  private progressBar: ProgressBarHelper | null = null;
  private isFetchingDMs: boolean = false;
  private menuElement: HTMLElement | null = null;
  /** Unknown-tab bulk selection: pubkeys of loaded conversations ticked for delete & mute. */
  private selectedUnknown: Set<string> = new Set();
  /** Disposer for the spam-mode button tooltip. */
  private spamTooltipDisposer: (() => void) | null = null;
  /** Coalescing timer for dm:badge-update bursts (see setupEventListeners). */
  private badgeRefreshTimer: number | null = null;

  constructor() {
    super();

    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--messages';
    this.eventBus = TypedEventBus.getInstance();
    this.router = Router.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
      loadingMessage: _('Loading more conversations...'),
    });
    this.outsideClickHandler = () => this.closeMenu();

    this.render();
    this.setupEventListeners();
    this.setupInfiniteScroll();
    // Sync the spam button with the persisted initial tab (its template
    // default is hidden; a mount landing on 'unknown' must show it).
    this.updateSpamButton();

    // IMPORTANT: Setup event listeners BEFORE loadInitialData()
    // because dmService.start() may emit events immediately if already running
    // Listen for fetch progress updates (for progress bar)
    this.subscriptionIds.push(
      this.eventBus.on(
        'dm:fetch-progress',
        (data: { current: number; total: number }) => {
          this.handleFetchProgress(data);
        }
      )
    );

    // Listen for fetch completion - then load conversations
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-complete', () => {
        void this.handleFetchComplete();
      })
    );

    // Listen for DM unsupported (bunker login — no NIP-44)
    this.subscriptionIds.push(
      this.eventBus.on('dm:unsupported', () => {
        this.showUnsupportedNotice();
      })
    );

    // Call loadInitialData AFTER event listeners are setup
    void this.loadInitialData();

    // Listen for badge updates (mark all read/unread) - only update badges, not full refresh.
    // Coalesced: a burst of badge-update events (bulk delete fires one per
    // conversation; a spam wave fires one per arrival) must produce ONE
    // refresh, not N overlapping ones — they reset the list concurrently and
    // starve it (stuck "Loading messages...").
    this.subscriptionIds.push(
      this.eventBus.on('dm:badge-update', () => {
        if (this.badgeRefreshTimer !== null) return;
        this.badgeRefreshTimer = window.setTimeout(() => {
          this.badgeRefreshTimer = null;
          if (this.isFetchingDMs) return;
          void this.updateBadgeCounts();
          void this.refreshConversationsQuiet();
        }, 400);
      })
    );

    // Listen for new messages during live subscription (after initial fetch)
    this.subscriptionIds.push(
      this.eventBus.on('dm:new-message', () => {
        // Only refresh if we're not currently fetching
        if (!this.isFetchingDMs) {
          void this.refreshConversationsQuiet();
        }
      })
    );

    // Listen for expired-message sweeps — the preview/lastMessageAt of the
    // affected conversation is recomputed in DMStore, so we need to re-fetch
    // the conversation list to show the updated (or cleared) preview.
    this.subscriptionIds.push(
      this.eventBus.on('dm:messages-expired', () => {
        if (!this.isFetchingDMs) {
          void this.refreshConversationsQuiet();
        }
      })
    );
  }

  /**
   * Render the messages view structure
   */
  private render(): void {
    this.container.innerHTML = `
      <div class="back-padder">
        <div class="messages-view__header progress-bar-container">
          <h1>${_('Messages')}</h1>
          <div class="messages-view__actions">
            <button class="btn btn--medium messages-view__spam-btn" data-spam-btn hidden>
              ${_('Spam mode')}
            </button>
            <button class="btn btn--medium messages-view__compose-btn">
              ${_('New Message')}
            </button>
            <button class="dropdown-menu-trigger messages-view__menu-trigger" aria-label="${_('Message options')}">
              <svg width="16" height="16"><use href="#icon-menu-dots"/></svg>
            </button>
          </div>
        </div>
        <div class="messages-view__tabs">
          <div class="tabs">
            <button class="tab${this.activeTab === 'known' ? ' tab--active' : ''}" data-tab="known">
              ${_('Known')}
              <span class="badge" data-badge="known" style="display: none;"></span>
            </button>
            <button class="tab${this.activeTab === 'unknown' ? ' tab--active' : ''}" data-tab="unknown">
              ${_('Unknown')}
              <span class="badge" data-badge="unknown" style="display: none;"></span>
            </button>
          </div>
        </div>
        <div class="messages-view__content">
          <div class="tab-content${this.activeTab === 'known' ? ' tab-content--active' : ''}" data-tab-content="known">
            <div class="messages-view__list" data-list="known">
              <div class="messages-view__loading">${_('Loading messages...')}</div>
            </div>
          </div>
          <div class="tab-content${this.activeTab === 'unknown' ? ' tab-content--active' : ''}" data-tab-content="unknown">
            <div class="messages-view__bulk-bar l-row--split" data-bulk-bar hidden>
              <a href="#" data-action="select-all-loaded">${_('Select all visible')}</a>
              <button class="btn btn--danger btn--medium" data-action="delete-selected" disabled>
                ${_('Delete selected (%s)', '0')}
              </button>
            </div>
            <div class="messages-view__list" data-list="unknown">
              <div class="messages-view__loading">${_('Loading messages...')}</div>
            </div>
          </div>
        </div>
        <div class="messages-view__load-older">
          <button class="btn btn--medium messages-view__load-older-btn">
            <span class="messages-view__load-older-label">${_('Load older messages')}</span>
          </button>
        </div>
      </div>
    `;

    // Initialize progress bar on header
    const header = this.container.querySelector(
      '.messages-view__header'
    ) as HTMLElement;
    if (header) {
      this.progressBar = new ProgressBarHelper(header);
    }
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Setup compose button
    const composeBtn = this.container.querySelector(
      '.messages-view__compose-btn'
    );
    composeBtn?.addEventListener('click', () => this.openComposeModal());

    // Spam-attack shield toggle (Unknown tab only)
    const spamBtn = this.container.querySelector(
      '[data-spam-btn]'
    ) as HTMLButtonElement | null;
    spamBtn?.addEventListener('click', () => {
      const engage = !DMToastNotifier.isSpamModeActive();
      DMToastNotifier.setSpamMode(engage);
      this.updateSpamButton();
      ToastService.show(
        engage
          ? _('Spam mode enabled, alerts off for 24 h')
          : _('Spam mode disabled'),
        'success'
      );
    });
    if (spamBtn) {
      this.spamTooltipDisposer = Tooltip.attach(
        spamBtn,
        _(
          'Silences alerts for new messages from unknown senders. Stays on for 24 h, then turns off automatically.'
        )
      );
    }

    // Bulk selection bar (Unknown tab only)
    this.container
      .querySelector('[data-action="select-all-loaded"]')
      ?.addEventListener('click', e => {
        e.preventDefault();
        this.toggleSelectAllLoaded();
      });
    this.container
      .querySelector('[data-action="delete-selected"]')
      ?.addEventListener('click', () => void this.handleDeleteSelected());

    // Setup menu trigger
    const menuTrigger = this.container.querySelector(
      '.messages-view__menu-trigger'
    );
    menuTrigger?.addEventListener('click', e => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // Setup tab click handlers using TabsHelper
    setupTabClickHandlers(this.container, tabId =>
      this.handleTabSwitch(tabId as TabFilter)
    );

    // "Load older messages" — manual backward paging from relays
    const loadOlderBtn = this.container.querySelector(
      '.messages-view__load-older-btn'
    );
    loadOlderBtn?.addEventListener('click', () => this.handleLoadOlder());
  }

  /**
   * Fetch one page of older history from relays, then refresh the visible list.
   * Disables the button and shows "No older messages" when the bottom is reached.
   */
  private async handleLoadOlder(): Promise<void> {
    const btn = this.container.querySelector(
      '.messages-view__load-older-btn'
    ) as HTMLButtonElement | null;
    const label = btn?.querySelector(
      '.messages-view__load-older-label'
    ) as HTMLElement | null;
    if (!btn || btn.disabled) return;

    btn.disabled = true;
    if (label) {
      label.textContent = _('Loading older messages…');
      label.classList.add('pulsate');
    }

    try {
      const result = (await this.dmsApi?.loadOlderMessages()) ?? {
        fetched: 0,
        reachedEnd: true,
      };
      // Older history may add conversations to the active tab — refresh it.
      await this.refreshConversationsQuiet();

      if (label) label.classList.remove('pulsate');
      if (result.reachedEnd) {
        if (label) label.textContent = _('No older messages');
        // Stays disabled — nothing more to load.
      } else {
        if (label) label.textContent = _('Load older messages');
        btn.disabled = false;
      }
    } catch (error) {
      this.systemLogger.warn(
        'MessagesView',
        `Failed to load older messages: ${errMessage(error)}`
      );
      if (label) {
        label.classList.remove('pulsate');
        label.textContent = _('Load older messages');
      }
      btn.disabled = false;
      ToastService.show(_('Could not load older messages'), 'error');
    }
  }

  /**
   * Handle tab switch
   */
  private handleTabSwitch(tab: TabFilter): void {
    if (this.activeTab === tab) return;

    this.activeTab = tab;
    // Persist so remounting (e.g. back-navigation from a conversation) lands
    // in the tab the user left from, not a reset 'known'.
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      /* storage unavailable — tab simply resets on remount */
    }

    // Selection and controls are Unknown-tab-only; drop them on tab change.
    this.clearBulkSelection();
    this.updateSpamButton();
    const bulkBar = this.container.querySelector(
      '[data-bulk-bar]'
    ) as HTMLElement | null;
    if (bulkBar) bulkBar.hidden = tab !== 'unknown';

    // Update tab UI and content using TabsHelper
    switchTabWithContent(this.container, tab);

    // Reset pagination for new tab
    this.currentOffset = 0;
    this.hasMoreConversations = true;
    this.conversations = [];

    // Setup infinite scroll for the new active list
    this.setupInfiniteScroll();

    // Load conversations for this tab
    void this.loadConversationsBatch();
  }

  /**
   * Setup infinite scroll on the active list container
   */
  private setupInfiniteScroll(): void {
    const list = this.container.querySelector(
      `[data-list="${this.activeTab}"]`
    );
    if (list) {
      this.infiniteScroll.observe(list as HTMLElement);
    }
  }

  /**
   * Load initial data - start DM service (which fetches messages)
   */
  private async loadInitialData(): Promise<void> {
    this.isFetchingDMs = true;
    this.progressBar?.start();

    // Start DM service - this triggers fetchHistoricalMessages
    // which emits dm:fetch-progress and dm:fetch-complete events
    await this.dmsApi?.start();
  }

  /**
   * Handle fetch progress updates
   */
  private handleFetchProgress(data: { current: number; total: number }): void {
    if (data.total > 0) {
      const percent = (data.current / data.total) * 100;
      this.progressBar?.update(percent);

      // Update loading text with progress
      const loadingEl = this.container.querySelector(
        `[data-list="${this.activeTab}"] .messages-view__loading`
      );
      if (loadingEl) {
        loadingEl.textContent = `Loading messages... ${data.current}/${data.total}`;
      }
    }
  }

  /**
   * Handle fetch completion - load and display conversations
   */
  private async handleFetchComplete(): Promise<void> {
    this.isFetchingDMs = false;
    this.progressBar?.complete();

    // Update badge counts
    await this.updateBadgeCounts();

    // Load conversations for active tab
    await this.loadConversationsBatch();
  }

  /**
   * Update unread badge counts
   */
  private async updateBadgeCounts(): Promise<void> {
    const counts = (await this.dmsApi?.getUnreadCountsSplit()) ?? {
      known: 0,
      unknown: 0,
      total: 0,
    };
    this.updateBadge('known', counts.known);
    this.updateBadge('unknown', counts.unknown);
  }

  /**
   * Update a single badge element
   */
  private updateBadge(type: TabFilter, count: number): void {
    const badge = this.container.querySelector(
      `[data-badge="${type}"]`
    ) as HTMLElement;
    if (!badge) return;

    if (count > 0) {
      badge.textContent = count.toString();
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }

  /**
   * Handle load more (infinite scroll trigger)
   */
  private async handleLoadMore(): Promise<void> {
    if (this.isLoading || !this.hasMoreConversations) return;
    await this.loadConversationsBatch();
  }

  /**
   * Refresh conversations without showing loading state (for live updates)
   */
  private async refreshConversationsQuiet(): Promise<void> {
    // Update badge counts
    await this.updateBadgeCounts();

    // Reset pagination
    this.currentOffset = 0;
    this.hasMoreConversations = true;
    this.conversations = [];

    // Reload without clearing UI first (prevents flicker)
    await this.loadConversationsBatch();
  }

  /**
   * Load a batch of conversations
   */
  private async loadConversationsBatch(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    const isInitialLoad = this.currentOffset === 0;
    const list = this.container.querySelector(
      `[data-list="${this.activeTab}"]`
    );

    try {
      // Show loading indicator for subsequent loads (not initial)
      if (!isInitialLoad) {
        this.infiniteScroll.showLoading();
      }

      // Get batch of conversations filtered by tab
      const batch =
        (await this.dmsApi?.getConversationsFiltered(
          this.activeTab,
          BATCH_SIZE,
          this.currentOffset
        )) ?? [];

      if (batch.length < BATCH_SIZE) {
        this.hasMoreConversations = false;
      }

      this.conversations.push(...batch);
      this.currentOffset += batch.length;

      await this.renderConversationsBatch(
        batch,
        isInitialLoad,
        list as HTMLElement
      );
    } catch (error) {
      const errorMsg = errMessage(error);
      if (this.conversations.length === 0) {
        this.systemLogger.error(
          'MessagesView',
          `Failed to load conversations: ${errorMsg}`
        );
        this.renderError(list as HTMLElement);
      } else {
        this.systemLogger.warn(
          'MessagesView',
          `Error loading more conversations: ${errorMsg}`
        );
      }
    } finally {
      this.isLoading = false;
      this.infiniteScroll.hideLoading();
      this.infiniteScroll.refresh();
    }
  }

  /**
   * Render a batch of conversations
   */
  private async renderConversationsBatch(
    batch: DMConversation[],
    isInitialLoad: boolean,
    list: HTMLElement
  ): Promise<void> {
    if (!list) return;

    // Handle empty state
    if (isInitialLoad && batch.length === 0) {
      const emptyMessage =
        this.activeTab === 'known'
          ? _('No messages from people you follow')
          : _('No messages from unknown users');

      list.innerHTML = `
        <div class="messages-view__empty">
          <svg width="48" height="48"><use href="#icon-email"/></svg>
          <p>${emptyMessage}</p>
          <p class="empty-hint">${_('Start a conversation by clicking "New Message"')}</p>
        </div>
      `;
      return;
    }

    // Clear loading message on initial load
    if (isInitialLoad) {
      list.innerHTML = '';
    }

    // Render each conversation item
    const results = await Promise.allSettled(
      batch.map(conv => this.renderConversationItem(conv))
    );

    // Append successful results and setup hover cards for each new item
    const conversationElements = results
      .filter(
        (r): r is PromiseFulfilledResult<HTMLElement> =>
          r.status === 'fulfilled'
      )
      .map(r => r.value);

    conversationElements.forEach(el => {
      list.appendChild(el);
      // Setup hover cards only for this new element
      setupUserMentionHandlers(el);
    });
  }

  /**
   * Render a single conversation item — the shared row skeleton comes from
   * buildConversationItem; this adds the unread state, delete button and
   * click handlers.
   */
  private async renderConversationItem(
    conversation: DMConversation
  ): Promise<HTMLElement> {
    const { element: item, displayName } = await buildConversationItem({
      pubkey: conversation.pubkey,
      preview: conversation.lastMessagePreview,
      timestamp: conversation.lastMessageAt,
    });
    if (conversation.unreadCount > 0) {
      item.classList.add('ui-list__item--unread', 'conversation-item--unread');
    }

    item.innerHTML += `
      ${
        conversation.unreadCount > 0
          ? `
        <div class="badge">${conversation.unreadCount}</div>
      `
          : ''
      }
      <button class="conversation-item__delete" aria-label="${this.activeTab === 'unknown' ? `${_('Delete &amp; mute sender')}` : `${_('Delete conversation')}`}" title="${this.activeTab === 'unknown' ? `${_('Delete &amp; mute sender')}` : `${_('Delete conversation')}`}">
        <svg width="18" height="18"><use href="#icon-trash"/></svg>
      </button>
    `;

    // Unknown-tab bulk selection: leading checkbox, survives quiet re-renders
    // via the selectedUnknown set. Added AFTER the innerHTML += above (re-
    // parsing wipes listeners). Rule: clicking the checkbox toggles selection
    // ONLY; every other click on the row opens the DM. Enforced twice — the
    // wrapper swallows clicks (label click + label-forwarded synthetic input
    // click) and the row handler below ignores anything originating inside
    // the wrapper.
    if (this.activeTab === 'unknown') {
      const checked = this.selectedUnknown.has(conversation.pubkey);
      item.insertAdjacentHTML(
        'afterbegin',
        `<label class="nn-checkbox nn-checkbox--compact conversation-item__select">
          <input type="checkbox" data-conv-select data-pubkey="${escapeHtmlAttr(conversation.pubkey)}" aria-label="${_('Select conversation for deletion')}"${checked ? ' checked' : ''} />
        </label>`
      );
      const wrapper = item.querySelector(
        '.conversation-item__select'
      ) as HTMLElement | null;
      const checkbox = wrapper?.querySelector(
        'input[data-conv-select]'
      ) as HTMLInputElement | null;
      wrapper?.addEventListener('click', e => e.stopPropagation());
      checkbox?.addEventListener('change', () => {
        if (checkbox.checked) this.selectedUnknown.add(conversation.pubkey);
        else this.selectedUnknown.delete(conversation.pubkey);
        this.updateBulkBar();
      });
    }

    // Click handler to open conversation — but never when the click originated
    // inside the bulk-select checkbox. Belt-and-suspenders next to the
    // wrapper's stopPropagation: the label-forwarded synthetic click and any
    // future event-path quirk are caught by this target check too.
    item.addEventListener('click', e => {
      if (
        (e.target as HTMLElement | null)?.closest?.(
          '.conversation-item__select'
        )
      )
        return;
      this.openConversation(conversation.pubkey);
    });

    // Per-row delete — stop propagation so it doesn't open the conversation
    const deleteBtn = item.querySelector('.conversation-item__delete');
    deleteBtn?.addEventListener('click', e => {
      e.stopPropagation();
      void this.confirmDeleteConversation(conversation.pubkey, displayName);
    });

    return item;
  }

  /**
   * Confirm + delete a conversation. In the Unknown (spam) tab this also mutes
   * the sender; in the Known tab it's a plain local soft-delete.
   */
  private async confirmDeleteConversation(
    partnerPubkey: string,
    displayName: string
  ): Promise<void> {
    const { ModalService } = await import('../../services/ModalService');
    const isUnknown = this.activeTab === 'unknown';

    const confirmed = await ModalService.getInstance().confirm({
      title: isUnknown ? _('Delete & mute') : _('Delete conversation'),
      message: isUnknown
        ? _(
            "Delete this conversation and mute %s? They won't appear in your messages again.",
            displayName
          )
        : _(
            "Delete this conversation with %s? It's removed only from this device.",
            displayName
          ),
      confirmText: _('Delete'),
      cancelText: _('Cancel'),
      confirmDestructive: true,
    });
    if (!confirmed) return;

    if (isUnknown) {
      await this.dmsApi?.deleteAndMute(partnerPubkey);
    } else {
      await this.dmsApi?.deleteConversation(partnerPubkey);
    }

    // Remove the row from the DOM immediately
    this.container
      .querySelector(`.conversation-item[data-pubkey="${partnerPubkey}"]`)
      ?.remove();
    this.conversations = this.conversations.filter(
      c => c.pubkey !== partnerPubkey
    );
    ToastService.show(
      isUnknown
        ? _('Conversation deleted & sender muted')
        : _('Conversation deleted'),
      'success'
    );
  }

  /**
   * Bulk delete for the Unknown (spam) tab: delete & mute every selected
   * conversation. Same semantics as the per-row "Delete & mute sender" —
   * one call per conversation, local purge + private mute.
   */
  private async handleDeleteSelected(): Promise<void> {
    const pubkeys = [...this.selectedUnknown];
    if (pubkeys.length === 0) return;

    const { ModalService } = await import('../../services/ModalService');
    const confirmed = await ModalService.getInstance().confirm({
      title: _('Delete selected conversations'),
      message: tn(
        "Delete %s conversation and mute its sender? It won't appear in your messages again.",
        "Delete %s conversations and mute their senders? They won't appear in your messages again.",
        pubkeys.length,
        String(pubkeys.length)
      ),
      confirmText: _('Delete'),
      cancelText: _('Cancel'),
      confirmDestructive: true,
    });
    if (!confirmed) return;

    let failed = 0;
    const deleted: string[] = [];
    for (const pubkey of pubkeys) {
      try {
        await this.dmsApi?.deleteAndMute(pubkey);
        deleted.push(pubkey);
      } catch (error) {
        failed++;
        diagLog('dms', 'Bulk delete of a conversation failed', {
          pubkey,
          error: errMessage(error),
        });
        this.systemLogger.warn(
          'MessagesView',
          'Bulk delete: a conversation could not be deleted. Try again later.'
        );
      }
    }

    // Optimistically remove the successfully deleted rows from the DOM.
    deleted.forEach(pk => {
      this.container
        .querySelector(`.conversation-item[data-pubkey="${pk}"]`)
        ?.remove();
      this.conversations = this.conversations.filter(c => c.pubkey !== pk);
      this.selectedUnknown.delete(pk);
    });
    this.updateBulkBar();

    if (failed === 0) {
      ToastService.show(_('Conversations deleted & senders muted'), 'success');
    } else {
      ToastService.show(
        _(
          '%s of %s conversations deleted',
          String(deleted.length),
          String(pubkeys.length)
        ),
        'warning'
      );
    }
  }

  /** Reflect the current selection state in the bulk bar controls. */
  private updateBulkBar(): void {
    const btn = this.container.querySelector(
      '[data-action="delete-selected"]'
    ) as HTMLButtonElement | null;
    if (btn) {
      btn.textContent = _(
        'Delete selected (%s)',
        String(this.selectedUnknown.size)
      );
      btn.disabled = this.selectedUnknown.size === 0;
    }
    const link = this.container.querySelector(
      '[data-action="select-all-loaded"]'
    );
    if (link)
      link.textContent = this.allLoadedSelected
        ? _('Unselect all visible')
        : _('Select all visible');
  }

  private get allLoadedSelected(): boolean {
    return (
      this.conversations.length > 0 &&
      this.conversations.every(c => this.selectedUnknown.has(c.pubkey))
    );
  }

  /** Select / unselect every currently LOADED conversation in the Unknown tab. */
  private toggleSelectAllLoaded(): void {
    const checked = !this.allLoadedSelected;
    if (checked) {
      this.conversations.forEach(c => this.selectedUnknown.add(c.pubkey));
    } else {
      this.selectedUnknown.clear();
    }
    this.container
      .querySelectorAll<HTMLInputElement>('input[data-conv-select]')
      .forEach(cb => {
        cb.checked = checked;
      });
    this.updateBulkBar();
  }

  /** Drop the bulk selection and re-sync the controls. */
  private clearBulkSelection(): void {
    this.selectedUnknown.clear();
    this.updateBulkBar();
  }

  /** Spam-mode toggle: visible only in the Unknown tab, danger-styled when active. */
  private updateSpamButton(): void {
    const btn = this.container.querySelector(
      '[data-spam-btn]'
    ) as HTMLButtonElement | null;
    if (!btn) return;
    btn.hidden = this.activeTab !== 'unknown';
    const active = DMToastNotifier.isSpamModeActive();
    btn.textContent = active ? _('Spam mode active') : _('Spam mode');
    btn.classList.toggle('btn--danger', active);
    btn.classList.toggle('btn--medium', !active);
  }

  /**
   * Open a conversation
   */
  private openConversation(partnerPubkey: string): void {
    // Mark as read
    void this.dmsApi?.markAsRead(partnerPubkey);

    // Navigate to conversation view
    this.router.navigate(`/messages/${partnerPubkey}`);
  }

  /**
   * Open compose modal for new message
   */
  private openComposeModal(): void {
    const modal = new DMComposeModal();
    modal.show();
  }

  /**
   * Create the dropdown menu
   */
  private createMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'dropdown-menu messages-view__menu';
    menu.style.display = 'none';

    menu.innerHTML = `
      <button class="dropdown-menu-item" data-action="mark-all-read">
        <svg width="16" height="16"><use href="#icon-checkmark"/></svg>
        ${_('Mark all read')}
      </button>
      <button class="dropdown-menu-item" data-action="mark-all-unread">
        <svg width="16" height="16"><use href="#icon-circle"/></svg>
        ${_('Mark all unread')}
      </button>
      <button class="dropdown-menu-item" data-action="resync">
        <svg width="16" height="16"><use href="#icon-sync"/></svg>
        ${_('Re-sync messages')}
      </button>
    `;

    // Setup menu click handler
    menu.addEventListener('click', e => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const menuItem = target.closest('.dropdown-menu-item') as HTMLElement;
      if (menuItem) {
        const action = menuItem.dataset.action;
        if (action) {
          void this.handleMenuAction(action);
          this.closeMenu();
        }
      }
    });

    // Append to body for proper positioning
    document.body.appendChild(menu);

    return menu;
  }

  /**
   * Show notice when DMs are not available (bunker login)
   */
  private showUnsupportedNotice(): void {
    this.isFetchingDMs = false;
    this.progressBar?.reset();

    this.container.innerHTML = `
      <div class="messages-view__header">
        <h1>${_('Messages')}</h1>
      </div>
      <div class="messages-view__empty">
        <svg width="48" height="48"><use href="#icon-email"/></svg>
        <p>${_('Direct messages are not available with Bunker URL login')}</p>
        <p class="empty-hint">${_('Your remote signer does not support NIP-44 encryption required for private messages. Use a browser extension or NoorSigner for full DM access.')}</p>
      </div>
    `;
  }

  /**
   * Render error state
   */
  private renderError(list: HTMLElement): void {
    if (!list) return;

    list.innerHTML = `
      <div class="messages-view__error">
        <p>${_('Failed to load messages')}</p>
        <button class="btn btn--medium" onclick="location.reload()">${_('Retry')}</button>
      </div>
    `;
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
   * Open menu
   */
  private openMenu(): void {
    // Create menu if it doesn't exist
    if (!this.menuElement) {
      this.menuElement = this.createMenu();
    }

    this.menuElement.style.display = 'block';
    this.menuOpen = true;
    this.positionMenu();

    // Add outside click listener
    setTimeout(() => {
      document.addEventListener('click', this.outsideClickHandler);
    }, 0);
  }

  /**
   * Close menu
   */
  private closeMenu(): void {
    if (this.menuElement) {
      this.menuElement.style.display = 'none';
    }
    this.menuOpen = false;
    document.removeEventListener('click', this.outsideClickHandler);
  }

  /**
   * Position menu below trigger
   */
  private positionMenu(): void {
    const trigger = this.container.querySelector(
      '.messages-view__menu-trigger'
    ) as HTMLElement;
    if (!trigger || !this.menuElement) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = this.menuElement.getBoundingClientRect();

    // Position below trigger, aligned to right
    this.menuElement.style.position = 'fixed';
    this.menuElement.style.top = `${triggerRect.bottom + 4}px`;
    this.menuElement.style.left = `${triggerRect.right - menuRect.width}px`;
    this.menuElement.style.zIndex = '1000';
  }

  /**
   * Handle menu actions
   */
  private async handleMenuAction(action: string): Promise<void> {
    switch (action) {
      case 'mark-all-read':
        await this.dmsApi?.markAllAsRead();
        // Immediately update UI (don't wait for event)
        await this.refreshConversationsQuiet();
        ToastService.show(_('All messages marked as read'), 'success');
        break;
      case 'mark-all-unread':
        await this.dmsApi?.markAllAsUnread();
        // Immediately update UI (don't wait for event)
        await this.refreshConversationsQuiet();
        ToastService.show(_('All messages marked as unread'), 'success');
        break;
      case 'resync': {
        const { ModalService } = await import('../../services/ModalService');
        const confirmed = await ModalService.getInstance().confirm({
          title: _('Re-sync messages'),
          message: _(
            'Re-fetch your full message history from the relays. Existing messages are kept — this only pulls anything missing. May take a moment.'
          ),
          confirmText: _('Re-sync'),
          cancelText: _('Cancel'),
        });
        if (!confirmed) break;
        // Drive the same progress UI as the initial load; completion resets it
        // via the dm:fetch-complete listener.
        this.isFetchingDMs = true;
        this.progressBar?.start();
        await this.dmsApi?.resyncAll();
        break;
      }
    }
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
    this.spamTooltipDisposer?.();
    this.spamTooltipDisposer = null;
    // Remove menu from DOM
    if (this.menuElement) {
      this.menuElement.remove();
      this.menuElement = null;
    }
    this.infiniteScroll.destroy();
    this.progressBar?.reset();
    if (this.badgeRefreshTimer !== null) {
      clearTimeout(this.badgeRefreshTimer);
      this.badgeRefreshTimer = null;
    }
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
  }
}
