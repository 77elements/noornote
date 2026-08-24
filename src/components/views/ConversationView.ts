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
import {
  DISAPPEARING_PRESETS,
  chipLabelForDuration,
  formatRemaining,
  isActive,
  labelForDuration,
} from '../../services/dm/DMExpiration';
import { TypedEventBus } from '../../core/TypedEventBus';
import { Router } from '../../services/Router';
import { SystemLogger } from '../../services/SystemLogger';
import { MuteOrchestrator } from '../../lists/mutes';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { TimelineModuleApi } from '../../modules/timeline/contracts';
import type { NotificationsModuleApi } from '../../modules/notifications/contracts';
import { ToastService } from '../../services/ToastService';
import { AuthGuard } from '../../services/AuthGuard';
import { AuthService } from '../../services/AuthService';
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
    return (this._dmsApi ??=
      ModuleLoader.getInstance().getApi<DMsModuleApi>('dms'));
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
  /** Subscription for `dm:disappearing-changed` — re-renders chip + reloads setting. */
  private disappearingChangedSubId: string | null = null;
  /** Subscription for `dm:disappearing-request` — shows inline banner. */
  private disappearingRequestSubId: string | null = null;
  /** Subscription for `dm:messages-expired` — drops expired bubbles in place. */
  private messagesExpiredSubId: string | null = null;
  /** Current per-conversation disappearing setting. undefined=undecided, 0=off, >0=seconds. */
  private disappearingSeconds: number | undefined = undefined;
  /** Peer duration we last prompted about (avoids re-prompting for same duration). */
  private lastPromptedPeerDuration: number | undefined = undefined;
  /** 60s tick that refreshes the per-bubble countdown labels in place. */
  private countdownTickTimer: number | null = null;
  /**
   * Tracks whether the initial user:login has been seen. The first login
   * (session restore / fresh login) is the "expected" login for this view.
   * Subsequent logins mean an account switch happened while this view was
   * mounted — we redirect to /messages so the user lands on their own DM
   * overview instead of a stale conversation from the previous account.
   */
  private hasSeenInitialLogin: boolean = false;
  /** Subscription for user:login (account-switch detection). */
  private accountSwitchSubId: string | null = null;

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
    void this.loadConversation();

    // Listen for new messages in this conversation
    this.subscriptionId = this.eventBus.on(
      'dm:new-message',
      (data: { message: DMMessage; conversationWith: string }) => {
        if (data.conversationWith === this.partnerPubkey) {
          // A sent message can be emitted twice in a race: once optimistically and
          // once when its own gift-wrap echoes back from the relay. Both carry the
          // same rumor id (and wrapId), so ignore one we've already rendered.
          const incoming = data.message;
          const isDuplicate = this.messages.some(
            m =>
              m.id === incoming.id ||
              (!!incoming.wrapId && m.wrapId === incoming.wrapId)
          );
          if (isDuplicate) return;

          this.messages.push(incoming);

          // Re-render the disappearing banner regardless — a new incoming tagged
          // message may change the pending peer duration (e.g. peer switched from
          // 7d to 1h) and require a fresh prompt.
          this.renderDisappearingZone();

          // Only append the bubble if the message isn't pending acceptance.
          // Pending messages (incoming tagged, duration not yet accepted) stay
          // hidden in the store until the user clicks Yes on the banner.
          if (!this.shouldRenderMessage(incoming)) return;

          const container = this.messagesContainer;
          if (container) {
            const emptyState = container.querySelector(
              '.conversation-view__empty'
            );
            if (emptyState) emptyState.remove();
            container.appendChild(this.renderMessage(incoming));
          }
          this.scrollToBottom();
        }
      }
    );

    // On reload this view can mount before DMService has populated the store
    // (start() runs after routing), so the initial load reads an empty store and
    // shows "No messages yet". Reload once the historical fetch completes —
    // guarded to the still-empty case so an active conversation isn't disrupted
    // by the periodic background sync.
    this.fetchCompleteSubId = this.eventBus.on('dm:fetch-complete', () => {
      if (this.messages.length === 0) {
        void this.loadConversation();
      }
    });

    // Per-conversation disappearing setting changed (this device or peer side).
    // Reload the cached value and update the chip + menu checkmark.
    this.disappearingChangedSubId = this.eventBus.on(
      'dm:disappearing-changed',
      data => {
        if (data.partnerPubkey !== this.partnerPubkey) return;
        this.disappearingSeconds = data.seconds;
        this.renderDisappearingChip();
        this.refreshMenuCheckmark();
      }
    );

    // Peer sent a message carrying an `expiration` tag while our local setting
    // is still undecided. Show the request banner so the user can accept/decline
    // once. After any decision the banner never re-fires for this conversation.
    this.disappearingRequestSubId = this.eventBus.on(
      'dm:disappearing-request',
      data => {
        if (data.partnerPubkey !== this.partnerPubkey) return;
        this.renderDisappearingBanner();
      }
    );

    // Sweep deleted one or more messages in this conversation. Drop them from
    // the local array and the DOM without a full reload.
    this.messagesExpiredSubId = this.eventBus.on(
      'dm:messages-expired',
      data => {
        if (data.partnerPubkey !== this.partnerPubkey) return;
        const now = Math.floor(Date.now() / 1000);
        const before = this.messages.length;
        this.messages = this.messages.filter(
          m => !m.expiresAt || m.expiresAt > now
        );
        const removed = before - this.messages.length;
        if (removed > 0) {
          // Remove the expired bubbles from the DOM in place.
          const container = this.messagesContainer;
          if (container) {
            container.querySelectorAll('[data-msg-id]').forEach(el => {
              const msgId = (el as HTMLElement).dataset.msgId;
              if (msgId && !this.messages.some(m => m.id === msgId)) {
                el.remove();
              }
            });
          }
        }
      }
    );

    // Per-minute countdown refresh: update all visible "X left" labels in place,
    // AND remove expired messages from the local array + DOM. The IDB sweep
    // (DMService) handles the actual deletion; this is a belt-and-suspenders
    // local check so bubbles vanish live without relying on event propagation.
    this.countdownTickTimer = window.setInterval(() => {
      this.refreshCountdowns();
      this.removeExpiredFromDom();
    }, 60_000);
    // Also run once 5s after mount to catch anything that expired while the
    // view was loading.
    setTimeout(() => this.removeExpiredFromDom(), 5_000);

    // Detect account switches: the first user:login is the initial session
    // restore / fresh login (expected). Subsequent logins mean the user
    // switched accounts via the AccountSwitcher while this ConversationView
    // was mounted — redirect to /messages so they see their own DM overview,
    // not the stale conversation from the previous account.
    //
    // CRITICAL: if a user is already logged in when this view is constructed
    // (session restore happened before the router mounted the view), the
    // initial user:login event has already fired and will NOT be caught by
    // the subscription below. So we pre-set hasSeenInitialLogin based on
    // whether a user is currently logged in.
    this.hasSeenInitialLogin = !!AuthService.getInstance().getCurrentUser();
    this.accountSwitchSubId = this.eventBus.on('user:login', () => {
      if (this.hasSeenInitialLogin) {
        this.router.navigate('/messages');
      }
      this.hasSeenInitialLogin = true;
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
      <div class="conversation-view__disappearing-zone" data-zone="disappearing"></div>
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
      enableHoverCard: true,
    });

    const userContainer = this.container.querySelector(
      '.conversation-view__user'
    );
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
    const menuTrigger = this.container.querySelector(
      '.conversation-view__menu-trigger'
    );
    menuTrigger?.addEventListener('click', e => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // Textarea auto-resize and send button enable
    const textarea = this.container.querySelector(
      '.conversation-view__textarea'
    ) as HTMLTextAreaElement;
    const sendBtn = this.container.querySelector(
      '.conversation-view__send-btn'
    ) as HTMLButtonElement;

    textarea?.addEventListener('input', () => {
      // Auto-resize
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;

      // Enable/disable send button
      sendBtn.disabled = !textarea.value.trim();
    });

    // Send on Enter (without Shift)
    textarea?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim()) {
          void this.sendMessage();
        }
      }
    });

    // Send button click
    sendBtn?.addEventListener('click', () => {
      if (!this.isSending && textarea.value.trim()) {
        void this.sendMessage();
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
    // Rebuild menu contents on each open so the active-preset checkmark and
    // any new private-mutes availability are always up to date.
    if (!this.menuElement) {
      this.menuElement = this.createMenu();
      document.body.appendChild(this.menuElement);
    } else {
      this.menuElement.innerHTML = this.buildMenuHtml();
    }

    // Position menu
    const trigger = this.container.querySelector(
      '.conversation-view__menu-trigger'
    );
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
  private static readonly CHECK_ICON = `<svg width="14" height="14" class="note-menu-item__check"><use href="#icon-checkmark"/></svg>`;

  /**
   * Build the inner HTML of the 3-dot menu. Called fresh on each open() so
   * the active disappearing preset's checkmark stays in sync with state.
   */
  private buildMenuHtml(): string {
    const privateMutesEnabled =
      MuteOrchestrator.getInstance().isPrivateMutesEnabled();
    const muteItems = privateMutesEnabled
      ? this.createMuteMenuItems(['mute-privately', 'mute-publicly'])
      : this.createMuteMenuItems(['mute-publicly']);

    const disappearingItems = DISAPPEARING_PRESETS.map(p => {
      const checked =
        this.disappearingSeconds === p.seconds
          ? ConversationView.CHECK_ICON
          : '';
      return `
        <button class="note-menu-item" data-action="disappear" data-seconds="${p.seconds}">
          <span class="note-menu-item__icon-spacer"></span>
          ${p.label}
          ${checked}
        </button>
      `;
    }).join('');

    // Show a checkmark on "Custom…" if the current value is active and not
    // one of the fixed presets.
    const isCustomActive =
      this.disappearingSeconds !== undefined &&
      this.disappearingSeconds > 0 &&
      !DISAPPEARING_PRESETS.some(p => p.seconds === this.disappearingSeconds);
    const customChecked = isCustomActive ? ConversationView.CHECK_ICON : '';
    const customLabel =
      isCustomActive && typeof this.disappearingSeconds === 'number'
        ? `Custom (${labelForDuration(this.disappearingSeconds)})`
        : 'Custom…';

    return `${muteItems}
      <button class="note-menu-item note-menu-item--danger" data-action="delete-conversation">
        <svg width="16" height="16"><use href="#icon-trash"/></svg>
        Delete conversation
      </button>
      <div class="dropdown-menu-divider"></div>
      <div class="dropdown-menu-header">Disappearing messages</div>
      ${disappearingItems}
      <button class="note-menu-item" data-action="disappear-custom">
        <span class="note-menu-item__icon-spacer"></span>
        ${customLabel}
        ${customChecked}
      </button>
    `;
  }

  /**
   * Create the mute menu dropdown
   */
  private createMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'note-menu-dropdown';
    menu.style.display = 'none';
    menu.innerHTML = this.buildMenuHtml();

    menu.addEventListener('click', e => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest(
        '.note-menu-item'
      ) as HTMLElement;
      if (!item) return;

      this.closeMenu();
      const action = item.dataset.action;
      if (action === 'delete-conversation') {
        void this.confirmDelete();
      } else if (action === 'disappear') {
        const seconds = Number(item.dataset.seconds);
        void this.applyDisappearingChoice(seconds);
      } else if (action === 'disappear-custom') {
        void this.openCustomDisappearingModal();
      } else if (action === 'mute-privately' || action === 'mute-publicly') {
        void this.muteUser(action === 'mute-privately');
      }
    });

    return menu;
  }

  /**
   * Apply a user-picked disappearing preset. Writes through to DMService which
   * emits `dm:disappearing-changed`; our subscription re-renders the chip and
   * the menu checkmark, and dismisses the request banner if it was visible.
   */
  private async applyDisappearingChoice(seconds: number): Promise<void> {
    try {
      await this.dmsApi?.setDisappearing(this.partnerPubkey, seconds);
      this.removeDisappearingBanner();
      ToastService.show(
        seconds === 0
          ? 'Disappearing messages off'
          : 'Disappearing messages enabled',
        'success'
      );
    } catch (_error) {
      this.systemLogger.error(
        'ConversationView',
        'Failed to set disappearing:',
        _error
      );
      ToastService.show('Could not update setting', 'error');
    }
  }

  /**
   * Handle "Yes" on the request banner — accept the peer's duration:
   *   - Updates our outgoing setting to match (so future outgoing gets tagged)
   *   - Records the duration as "prompted & accepted" (no re-prompt until peer changes)
   *   - All pending messages with this duration become visible (re-render)
   */
  private async acceptPeerDuration(peerDuration: number): Promise<void> {
    try {
      // setDisappearing updates both `disappearingSeconds` and (since >0)
      // `lastPromptedPeerDuration` atomically in DMStore.
      await this.dmsApi?.setDisappearing(this.partnerPubkey, peerDuration);
      this.disappearingSeconds = peerDuration;
      this.lastPromptedPeerDuration = peerDuration;
      this.renderMessages();
      this.renderDisappearingZone();
    } catch (_error) {
      this.systemLogger.error(
        'ConversationView',
        'Failed to accept peer duration:',
        _error
      );
      ToastService.show('Could not accept', 'error');
    }
  }

  /**
   * Handle "No" on the request banner — reject the peer's duration:
   *   - Records the duration as "prompted & rejected" (no re-prompt, future
   *     incoming messages with same duration are silently dropped by DMService)
   *   - Deletes all currently-pending messages with this duration locally
   *   - Our outgoing setting stays unchanged
   */
  private async rejectPeerDuration(peerDuration: number): Promise<void> {
    try {
      await this.dmsApi?.setLastPromptedPeerDuration(
        this.partnerPubkey,
        peerDuration
      );
      const deleted =
        (await this.dmsApi?.deletePendingMessagesByDuration(
          this.partnerPubkey,
          peerDuration
        )) ?? 0;
      this.lastPromptedPeerDuration = peerDuration;
      // Drop the rejected messages from the in-memory list too.
      if (deleted > 0) {
        this.messages = this.messages.filter(m => {
          if (typeof m.expiresAt !== 'number') return true;
          return m.expiresAt - m.createdAt !== peerDuration;
        });
      }
      this.renderMessages();
      this.renderDisappearingZone();
    } catch (_error) {
      this.systemLogger.error(
        'ConversationView',
        'Failed to reject peer duration:',
        _error
      );
      ToastService.show('Could not reject', 'error');
    }
  }

  /**
   * Open the custom-duration picker modal. Lets the user enter any duration
   * (number + unit Hours/Days/Weeks) instead of picking one of the fixed
   * presets. Floor is 1 hour so the wrap has time to reach the recipient
   * before relays delete it; ceiling is 1 year to stay within the preset range.
   */
  private async openCustomDisappearingModal(): Promise<void> {
    const { ModalService } = await import('../../services/ModalService');

    // Initial unit/value: pick a sensible default from the current setting.
    // 0/undefined → 1 day; otherwise decompose the active value into the
    // closest unit so the user sees their current value pre-filled.
    const currentSec =
      typeof this.disappearingSeconds === 'number' &&
      this.disappearingSeconds > 0
        ? this.disappearingSeconds
        : 7 * 86_400;
    let unit: 'minutes' | 'hours' | 'days' | 'weeks' = 'days';
    let value: number;
    if (currentSec % (7 * 86_400) === 0) {
      unit = 'weeks';
      value = currentSec / (7 * 86_400);
    } else if (currentSec % 86_400 === 0) {
      unit = 'days';
      value = currentSec / 86_400;
    } else if (currentSec % 3600 === 0) {
      unit = 'hours';
      value = Math.max(1, Math.round(currentSec / 3600));
    } else {
      unit = 'minutes';
      value = Math.max(1, Math.round(currentSec / 60));
    }
    value = Math.max(1, Math.round(value));

    const content = document.createElement('div');
    content.className = 'modal-disappearing';
    content.innerHTML = `
      <p class="form__note">Messages will disappear after this time. Minimum: 1 minute, maximum: 1 year.</p>
      <div class="form__row">
        <label>Duration</label>
        <div class="modal-disappearing__row">
          <input type="number" class="input modal-disappearing__value" min="1" max="525600" value="${value}" />
          <div class="modal-disappearing__units" role="radiogroup" aria-label="Time unit">
            <button type="button" class="btn btn--mini" data-unit="minutes" role="radio" aria-checked="${unit === 'minutes'}">Minutes</button>
            <button type="button" class="btn btn--mini" data-unit="hours" role="radio" aria-checked="${unit === 'hours'}">Hours</button>
            <button type="button" class="btn btn--mini" data-unit="days" role="radio" aria-checked="${unit === 'days'}">Days</button>
            <button type="button" class="btn btn--mini" data-unit="weeks" role="radio" aria-checked="${unit === 'weeks'}">Weeks</button>
          </div>
        </div>
      </div>
      <p class="modal-disappearing__error" data-zone="error" hidden></p>
      <div class="l-row l-row--end-pair">
        <button type="button" class="btn btn--passive modal-disappearing__cancel">Cancel</button>
        <button type="button" class="btn modal-disappearing__apply">Apply</button>
      </div>
    `;

    // State held inside the modal closure so the unit toggle updates without
    // rebuilding the form.
    const state = { unit, value };
    const MINUTE_SECONDS = 60;
    const HOUR_SECONDS = 3600;
    const DAY_SECONDS = 86_400;
    const WEEK_SECONDS = 7 * 86_400;
    const MIN_SECONDS = MINUTE_SECONDS; // 1 minute floor (allows quick testing)
    const MAX_SECONDS = 365 * DAY_SECONDS; // 1 year ceiling

    const input = content.querySelector<HTMLInputElement>(
      '.modal-disappearing__value'
    )!;
    const unitButtons = content.querySelectorAll<HTMLButtonElement>(
      '.modal-disappearing__units [data-unit]'
    );
    const errorEl = content.querySelector<HTMLElement>('[data-zone="error"]')!;
    const cancelBtn = content.querySelector<HTMLButtonElement>(
      '.modal-disappearing__cancel'
    )!;
    const applyBtn = content.querySelector<HTMLButtonElement>(
      '.modal-disappearing__apply'
    )!;

    // Active unit button keeps the solid `.btn` look; inactive ones get
    // `.btn--passive` so the segmented-control state is visible at a glance.
    const refreshUnits = (): void => {
      unitButtons.forEach(b => {
        const isActive = b.dataset.unit === state.unit;
        b.setAttribute('aria-checked', isActive ? 'true' : 'false');
        b.classList.toggle('btn--passive', !isActive);
      });
      // Adjust the number-input max based on the unit so the floor/ceiling
      // can't be trivially exceeded.
      const maxForUnit =
        state.unit === 'minutes'
          ? Math.floor(MAX_SECONDS / MINUTE_SECONDS)
          : state.unit === 'hours'
            ? Math.floor(MAX_SECONDS / HOUR_SECONDS)
            : state.unit === 'days'
              ? Math.floor(MAX_SECONDS / DAY_SECONDS)
              : Math.floor(MAX_SECONDS / WEEK_SECONDS);
      input.max = String(maxForUnit);
    };
    refreshUnits();

    input.addEventListener('input', () => {
      state.value = Math.max(1, Number(input.value) || 1);
      errorEl.hidden = true;
    });
    unitButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        state.unit = btn.dataset.unit as 'minutes' | 'hours' | 'days' | 'weeks';
        refreshUnits();
      });
    });

    let settled = false;
    const close = (): void => {
      if (!settled) {
        settled = true;
        ModalService.getInstance().hide();
      }
    };

    const showError = (msg: string): void => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    };

    const tryApply = (): void => {
      const unitSeconds =
        state.unit === 'minutes'
          ? MINUTE_SECONDS
          : state.unit === 'hours'
            ? HOUR_SECONDS
            : state.unit === 'days'
              ? DAY_SECONDS
              : WEEK_SECONDS;
      const seconds = Math.round(state.value * unitSeconds);
      if (seconds < MIN_SECONDS) {
        showError('Duration must be at least 1 minute.');
        return;
      }
      if (seconds > MAX_SECONDS) {
        showError('Duration must be at most 1 year.');
        return;
      }
      close();
      void this.applyDisappearingChoice(seconds);
    };

    cancelBtn.addEventListener('click', close);
    applyBtn.addEventListener('click', tryApply);
    input.addEventListener('keydown', e => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        tryApply();
      }
    });

    ModalService.getInstance().show({
      title: 'Custom duration',
      content,
      width: '420px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
      onClose: () => {
        settled = true;
      },
    });

    setTimeout(() => input.focus(), 0);
  }

  /**
   * Render the appropriate content in the disappearing zone based on state.
   * Logs the decision for diagnostics so we can trace why a specific banner
   * (or none) was shown.
   */
  private renderDisappearingZone(): void {
    const zone = this.container.querySelector<HTMLElement>(
      '[data-zone="disappearing"]'
    );
    if (!zone) return;
    zone.innerHTML = '';

    const banner = this.buildBannerElement();
    if (banner) zone.appendChild(banner);
  }

  /**
   * Build the banner element for the current state, or return null if no
   * banner should be shown.
   *
   * State priority (most important first):
   *   1. Pending peer-duration change → request banner with Yes/No
   *      (incoming tagged msg whose duration ≠ our setting AND ≠ last prompted)
   *   2. Active setting matches latest incoming tagged msg → info chip
   *   3. Otherwise: empty
   *
   * The request banner MUST win over the info chip — otherwise once a user
   * has accepted any duration, peer changes would be silently swallowed.
   */
  private buildBannerElement(): HTMLElement | null {
    // State 1: pending peer-duration change — actionable banner (highest priority).
    const pendingDuration = this.getPendingPeerDuration();
    if (pendingDuration > 0) {
      const durationLabel = labelForDuration(pendingDuration).toLowerCase();
      const banner = document.createElement('div');
      banner.className =
        'conversation-view__disappearing-banner conversation-view__disappearing-banner--request';
      banner.innerHTML = `
        <div class="conversation-view__disappearing-banner-text">
          ⏱ Disappears in ~${durationLabel}
          <br />
          <span class="conversation-view__disappearing-banner-sub">Do you accept the time limitation?</span>
        </div>
        <div class="l-row l-row--center">
          <button type="button" class="btn btn--mini" data-action="accept-disappearing">Yes</button>
          <button type="button" class="btn btn--passive btn--mini" data-action="decline-disappearing">No</button>
        </div>
      `;
      banner
        .querySelector('[data-action="accept-disappearing"]')
        ?.addEventListener('click', () => {
          void this.acceptPeerDuration(pendingDuration);
        });
      banner
        .querySelector('[data-action="decline-disappearing"]')
        ?.addEventListener('click', () => {
          void this.rejectPeerDuration(pendingDuration);
        });
      return banner;
    }

    // State 2: active — info chip with countdown.
    if (isActive(this.disappearingSeconds)) {
      const banner = document.createElement('div');
      banner.className =
        'conversation-view__disappearing-banner conversation-view__disappearing-banner--info';
      banner.textContent = chipLabelForDuration(this.disappearingSeconds);
      return banner;
    }

    // State 3: nothing to show.
    return null;
  }

  /**
   * Find the peer's CURRENT duration from the LATEST incoming tagged message.
   * Returns 0 if there's no pending duration to prompt about.
   *
   * Only considers the single most-recent tagged incoming message — not ALL
   * tagged messages. This prevents an infinite accept-loop when the peer has
   * sent messages with DIFFERENT durations (e.g., first 10 min, then 3 min):
   * accepting one would make the other "pending" again if we checked all.
   */
  private getPendingPeerDuration(): number {
    let latest: DMMessage | undefined;
    for (const m of this.messages) {
      if (m.isMine) continue;
      if (typeof m.expiresAt !== 'number') continue;
      if (!latest || m.createdAt > latest.createdAt) latest = m;
    }
    if (!latest || typeof latest.expiresAt !== 'number') return 0;
    const peerDuration = latest.expiresAt - latest.createdAt;
    if (peerDuration <= 0) return 0;
    if (this.disappearingSeconds === peerDuration) return 0;
    if (this.lastPromptedPeerDuration === peerDuration) return 0;
    return peerDuration;
  }

  /** Re-render the disappearing zone (backwards-compat shim). */
  private renderDisappearingChip(): void {
    this.renderDisappearingZone();
  }

  /** Re-render the disappearing zone (backwards-compat shim). */
  private renderDisappearingBanner(): void {
    this.renderDisappearingZone();
  }

  /** Re-render the disappearing zone (backwards-compat shim). */
  private removeDisappearingBanner(): void {
    this.renderDisappearingZone();
  }

  /**
   * Refresh all visible "X left" countdown labels in place. Called every 60s
   * by the tick timer; cheap because we don't re-render the bubbles, just
   * update the textContent of `.message__expires-in` elements.
   */
  private refreshCountdowns(): void {
    const now = Math.floor(Date.now() / 1000);
    this.container
      .querySelectorAll<HTMLElement>('.message__expires-in')
      .forEach(el => {
        const expiresAt = Number(el.dataset.expiresAt);
        el.textContent = formatRemaining(expiresAt, now);
      });
  }

  /**
   * Remove expired messages from the local array AND the DOM. Called every
   * 60s by the tick timer. This is a LOCAL check — the actual IDB deletion
   * is handled by DMService's sweep. We do this here so bubbles vanish live
   * without depending on event propagation (which was unreliable).
   */
  private removeExpiredFromDom(): void {
    const now = Math.floor(Date.now() / 1000);
    const before = this.messages.length;
    this.messages = this.messages.filter(
      m => !m.expiresAt || m.expiresAt > now
    );
    const removed = before - this.messages.length;
    if (removed > 0) {
      const container = this.messagesContainer;
      if (container) {
        container.querySelectorAll('[data-msg-id]').forEach(el => {
          const msgId = (el as HTMLElement).dataset.msgId;
          if (msgId && !this.messages.some(m => m.id === msgId)) {
            el.remove();
          }
        });
      }
      // Re-evaluate the banner — the pending duration might have changed.
      this.renderDisappearingZone();
    }
  }

  /**
   * Update the active-preset checkmark in the menu without rebuilding it.
   * Used by the `dm:disappearing-changed` subscription; the next open() also
   * rebuilds, but this keeps a currently-open menu visually consistent.
   */
  private refreshMenuCheckmark(): void {
    if (!this.menuElement || !this.menuOpen) return;
    this.menuElement.innerHTML = this.buildMenuHtml();
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
      'mute-publicly': actions.length > 1 ? 'Mute user publicly' : 'Mute user',
    };

    return actions
      .map(
        action => `
      <button class="note-menu-item note-menu-item--danger" data-action="${action}">
        ${ConversationView.MUTE_ICON}
        ${labels[action]}
      </button>
    `
      )
      .join('');
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
      ToastService.show(
        `User muted ${isPrivate ? 'privately' : 'publicly'}`,
        'success'
      );

      // Refresh muted users in orchestrators
      const loader = ModuleLoader.getInstance();
      const timelineApi = loader.getApi<TimelineModuleApi>('timeline');
      const notifApi = loader.getApi<NotificationsModuleApi>('notifications');
      await Promise.all([
        timelineApi?.refreshMutedUsers() ?? Promise.resolve(),
        notifApi?.refreshMutedUsers() ?? Promise.resolve(),
      ]);

      // Notify that mute list was updated
      this.eventBus.emit('mute:updated');

      // Navigate back to messages list
      this.router.navigate('/messages');
    } catch (_error) {
      this.systemLogger.error(
        'ConversationView',
        `Failed to mute user: ${_error}`
      );
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

      // Load the per-conversation disappearing setting (also recovers from
      // IndexedDB eviction via the localStorage mirror in DMStore).
      this.disappearingSeconds =
        (await this.dmsApi?.getDisappearing(this.partnerPubkey)) ?? undefined;
      this.lastPromptedPeerDuration =
        (await this.dmsApi?.getLastPromptedPeerDuration(this.partnerPubkey)) ??
        undefined;

      // Load messages and sort oldest first (newest at bottom)
      this.messages =
        (await this.dmsApi?.getMessages(this.partnerPubkey)) ?? [];
      this.messages.sort((a, b) => a.createdAt - b.createdAt);

      // Render messages and scroll to bottom
      this.renderMessages();
      this.scrollToBottom();

      // NOW render the disappearing zone — must happen AFTER messages are
      // loaded so getPendingPeerDuration() can find incoming tagged messages
      // and decide whether to show the request banner (State 1) vs the info
      // chip (State 2). Calling it before getMessages() always sees an empty
      // list and falls through to State 2.
      this.renderDisappearingZone();
    } catch (_error) {
      this.systemLogger.error(
        'ConversationView',
        'Failed to load conversation:',
        _error
      );
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
   * Scroll messages container to bottom. Uses requestAnimationFrame so the
   * browser has re-laid-out after any DOM changes (e.g. the disappearing-zone
   * banner appearing/resizing between messages and input) before we compute
   * the scroll position. Without this, the latest message can be hidden
   * behind the banner zone.
   */
  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      const container = this.messagesContainer;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
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
      if (!this.shouldRenderMessage(msg)) return;
      const messageEl = this.renderMessage(msg);
      container.appendChild(messageEl);
    });
  }

  /**
   * Whether a message should be rendered in the conversation view.
   * Incoming tagged messages whose peer-duration hasn't been accepted yet
   * are held invisibly until the user accepts (Yes) or rejects (No → delete).
   * Own messages and non-tagged messages always render.
   */
  private shouldRenderMessage(msg: DMMessage): boolean {
    if (msg.isMine) return true;
    if (typeof msg.expiresAt !== 'number') return true;
    const peerDuration = msg.expiresAt - msg.createdAt;
    return this.disappearingSeconds === peerDuration;
  }

  /**
   * Render a single message with full content processing
   * Handles: links, media, npub mentions, hashtags, quoted notes
   */
  private renderMessage(message: DMMessage): HTMLElement {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${message.isMine ? 'message--own' : 'message--other'}`;
    messageEl.dataset.msgId = message.id;

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
    htmlWithMedia = replaceBolt11Placeholders(
      htmlWithMedia,
      processed.bolt11Invoices
    );

    // Optional per-bubble countdown for disappearing messages. Only rendered
    // when the bubble actually carries an expiresAt; updated in place every
    // 60s by refreshCountdowns().
    const expiresIn =
      typeof message.expiresAt === 'number'
        ? `<span class="message__expires-in" data-expires-at="${message.expiresAt}">${formatRemaining(message.expiresAt, Math.floor(Date.now() / 1000))}</span>`
        : '';

    messageEl.innerHTML = `
      <div class="message__content">${htmlWithMedia}</div>
      <div class="message__quotes"></div>
      <div class="message__meta">
        <span class="message__time">${this.formatTime(message.createdAt)}</span>
        ${expiresIn}
      </div>
    `;

    // Render quoted notes if any
    if (processed.quotedReferences.length > 0) {
      const quotesContainer = messageEl.querySelector('.message__quotes');
      if (quotesContainer) {
        this.quotedNoteRenderer.renderQuotedNotes(
          processed.quotedReferences,
          quotesContainer,
          false
        );
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
    const textarea = this.container.querySelector(
      '.conversation-view__textarea'
    ) as HTMLTextAreaElement;
    const sendBtn = this.container.querySelector(
      '.conversation-view__send-btn'
    ) as HTMLButtonElement;

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
      const success =
        (await this.dmsApi?.sendMessage(this.partnerPubkey, content)) ?? false;

      if (success) {
        this.systemLogger.info('ConversationView', 'Message sent');
      } else {
        textarea.value = content;
        this.systemLogger.error('ConversationView', 'Failed to send message');
        ToastService.show('Could not send message — please try again', 'error');
      }
    } catch (_error) {
      textarea.value = content;
      this.systemLogger.error(
        'ConversationView',
        'Error sending message:',
        _error
      );
      const timedOut =
        _error instanceof Error && _error.name === 'SignerTimeoutError';
      ToastService.show(
        timedOut
          ? 'Signer did not respond — message not sent'
          : 'Could not send message — please try again',
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

    const timeStr = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (isToday) {
      return timeStr;
    }

    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
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
    if (this.disappearingChangedSubId) {
      this.eventBus.off(this.disappearingChangedSubId);
      this.disappearingChangedSubId = null;
    }
    if (this.disappearingRequestSubId) {
      this.eventBus.off(this.disappearingRequestSubId);
      this.disappearingRequestSubId = null;
    }
    if (this.messagesExpiredSubId) {
      this.eventBus.off(this.messagesExpiredSubId);
      this.messagesExpiredSubId = null;
    }
    if (this.countdownTickTimer !== null) {
      clearInterval(this.countdownTickTimer);
      this.countdownTickTimer = null;
    }
    if (this.accountSwitchSubId) {
      this.eventBus.off(this.accountSwitchSubId);
      this.accountSwitchSubId = null;
    }
    if (this.userIdentity) {
      this.userIdentity.destroy();
      this.userIdentity = null;
    }
  }
}
