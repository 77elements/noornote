/**
 * Feedback Board addon view — public Kanban board (To Do / In Progress / Done)
 * between NoorNote users and the developer, kanbanstr-compatible (NIP-100
 * draft). See docs/todos/feedback-board.md.
 *
 * Pattern B addon view: enable-switch section + feature UI mounted into
 * div[data-addon-content="feedback-board"].
 */

import { View } from '../../components/views/View';
import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { NnDropdown } from '../../components/ui/NnDropdown';
import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { ErrorService } from '../../services/ErrorService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { escapeHtml } from '../../helpers/escapeHtml';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';
import { npubToUsername } from '../../helpers/npubToUsername';
import { hexToNpub } from '../../helpers/nip19';
import { capRelayHints } from '../../helpers/capRelayHints';
import { encodeNaddr, decodeNip19 } from '../../services/NostrToolsAdapter';
import { ClipboardActionsService } from '../../services/ClipboardActionsService';
import { RelayConfig } from '../../services/RelayConfig';
import { _, tn } from '../../i18n';
import {
  FeedbackBoardService,
  isDevPubkey,
  type FeedbackBoardState,
  type FeedbackComment,
} from './FeedbackBoardService';
import {
  FEEDBACK_CARD_KIND,
  FEEDBACK_COLUMNS,
  FEEDBACK_TICKET_TYPES,
  type FeedbackTicket,
  type FeedbackTicketStatus,
  type FeedbackTicketType,
} from './feedbackBoardConstants';
import { isFeedbackBoardEnabled, setFeedbackBoardEnabled } from './index';

export class FeedbackBoardSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;
  private eventBus: TypedEventBus;
  /** Called after the flag changed so the host view can re-render instantly. */
  public onToggled: ((enabled: boolean) => void) | null = null;

  constructor() {
    super('feedback-board-settings');
    this.eventBus = TypedEventBus.getInstance();
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.enableSwitch = new Switch({
      label: '',
      checked: isFeedbackBoardEnabled(),
      onChange: checked => {
        setFeedbackBoardEnabled(checked);
        this.eventBus.emit('feedback-board:addon-toggle', {
          enabled: checked,
        });
        this.onToggled?.(checked);
      },
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">${_('Enable Feedback Board')}</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">${_('A public board between you and the developer: file wishes and bugs, follow their progress, get a DM on every update. Tickets are public Nostr events.')}</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);
  }

  public unmount(): void {
    this.enableSwitch = null;
  }
}

export class FeedbackBoardAddonView extends View {
  private container: HTMLElement;
  private settings: FeedbackBoardSettings | null = null;
  private boardZone: HTMLElement | null = null;
  private service: FeedbackBoardService;
  private state: FeedbackBoardState | null = null;
  private openCardMenu: HTMLElement | null = null;
  private cardMenuOutsideHandler: (() => void) | null = null;
  private typeDropdown: NnDropdown | null = null;

  constructor() {
    super();
    this.service = FeedbackBoardService.getInstance();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-feedback-board';
    this.container.innerHTML = `
      <div class="back-padder">
        <h1>${_('Feedback Board')}</h1>
        <section class="section" id="feedback-board-settings-content"></section>
        <div data-addon-content="feedback-board"></div>
      </div>
    `;
    this.settings = new FeedbackBoardSettings();
    this.settings.mount(this.container);
    this.settings.onToggled = enabled => {
      if (enabled) {
        void this.refresh();
      } else if (this.boardZone) {
        this.boardZone.innerHTML = '';
        this.state = null;
      }
    };

    this.boardZone = this.container.querySelector(
      '[data-addon-content="feedback-board"]'
    );

    if (isFeedbackBoardEnabled()) {
      void this.refresh();
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.settings?.unmount();
    this.settings = null;
    this.container.innerHTML = '';
  }

  private usernameFor(pubkey: string): string {
    const npub = hexToNpub(pubkey) ?? '';
    return npubToUsername(npub);
  }

  /**
   * Open the ticket modal for a naddr deep link (/addons/feedback-board/:naddr). Decodes
   * the naddr, ensures the board state is loaded, finds the matching ticket
   * and opens the modal. Silently ignores invalid or non-board naddrs.
   */
  public async openDeepLink(naddr: string): Promise<void> {
    try {
      const decoded = decodeNip19(naddr);
      if (decoded.type !== 'naddr') return;
      const data = decoded.data as {
        kind: number;
        pubkey: string;
        identifier: string;
      };
      if (data.kind !== FEEDBACK_CARD_KIND) return;

      // The constructor kicks off refresh() only when the addon is enabled;
      // make sure the board state is available before searching for the
      // ticket.
      if (!this.state) {
        await this.refresh();
      }
      const ticket = this.state?.tickets.find(
        t => t.dTag === data.identifier && t.authorPubkey === data.pubkey
      );
      if (ticket) {
        void this.openTicketModal(ticket);
      }
    } catch {
      // Invalid naddr — silently ignore.
    }
  }

  private async refresh(): Promise<void> {
    if (!this.boardZone) return;
    // Stale-while-revalidate: paint the last known state immediately and
    // reconcile it in the background. The loading indicator stays for the
    // cold load only.
    const cached = this.service.getCachedBoard();
    if (cached) {
      this.state = cached;
      this.renderBoard();
    } else {
      this.boardZone.innerHTML = `<p class="feedback-board__loading pulsate">${_('Loading board…')}</p>`;
    }
    try {
      // Progressive hydration only on the cold path: a cached paint already
      // shows the full state, an intermediate cards-only render would flash
      // the comments away.
      this.state = await this.service.loadBoard(
        cached
          ? undefined
          : partial => {
              this.state = partial;
              this.renderBoard();
            }
      );
    } catch (error) {
      if (!cached) {
        this.boardZone.innerHTML = `<p class="feedback-board__error">${_('The board could not be loaded — check your connection.')}</p>`;
      }
      ErrorService.handle(error, 'feedback-board', false);
      return;
    }
    this.renderBoard();
  }

  private renderBoard(): void {
    if (!this.boardZone || !this.state) return;
    const isDev = this.service.isDev();
    const live = this.state.tickets.filter(t => !t.archived);
    const active = live.filter(t => t.status !== 'withdrawn');
    const withdrawn = live.filter(t => t.status === 'withdrawn');
    const archived = this.state.tickets.filter(t => t.archived);

    const columns = FEEDBACK_COLUMNS.map(status => {
      const columnTickets = active.filter(t => t.status === status);
      const cards = columnTickets.map(t => this.renderCard(t, isDev)).join('');
      return `
        <div class="feedback-board__col" data-status="${status}">
          <div class="feedback-board__col-head">
            <h2 class="h5">${this.service.statusLabel(status)}</h2>
            <span class="badge">${tn('%s ticket', '%s tickets', columnTickets.length)}</span>
          </div>
          <div class="feedback-board__cards">${cards}</div>
        </div>
      `;
    });

    this.boardZone.innerHTML = `
      <div class="l-row--right feedback-board__actions">
        <button class="btn btn--medium" data-board-action="new-ticket">${_('New Ticket')}</button>
      </div>
      <p class="feedback-board__notice">${_('Tickets are public — visible in every Nostr client (kanbanstr-compatible), not only in NoorNote.')}</p>
      <div class="feedback-board">${columns.join('')}</div>
      ${withdrawn.length ? this.renderWithdrawn(withdrawn) : ''}
      ${isDev ? this.renderArchive(archived) : ''}
    `;

    this.boardZone
      .querySelector('[data-board-action="new-ticket"]')
      ?.addEventListener('click', () => this.openNewTicketModal());
    this.wireCardHandlers(this.boardZone);
  }

  private typeLabel(type: FeedbackTicketType | undefined): string {
    const labels: Record<FeedbackTicketType, string> = {
      wish: _('Wish'),
      bug: _('Bug'),
      question: _('Question'),
      refinement: _('Refinement'),
    };
    return type ? (labels[type] ?? '') : '';
  }

  /**
   * Card context menu (3-dot): Copy Permalink (naddr — kanbanstr-compatible),
   * Copy event ID, and the NIP-09 delete (dev or original author only).
   */
  private toggleCardMenu(trigger: HTMLElement, ticket: FeedbackTicket): void {
    this.closeCardMenu();

    const isAuthor = this.service.currentPubkey() === ticket.authorPubkey;
    const canDelete = this.service.isDev() || isAuthor;

    const menu = document.createElement('div');
    menu.className = 'note-menu-dropdown';
    menu.dataset.dTag = ticket.dTag;

    const items: string[] = [
      `<button class="note-menu-item" data-action="copy-permalink">
        <svg width="16" height="16"><use href="#icon-link"/></svg>
        ${_('Copy Permalink')}
      </button>`,
      `<button class="note-menu-item" data-action="copy-event-id">
        <svg width="16" height="16"><use href="#icon-copy"/></svg>
        ${_('Copy event ID')}
      </button>`,
    ];

    if (canDelete) {
      items.push(`<button class="note-menu-item note-menu-item--danger" data-action="delete">
        <svg width="16" height="16"><use href="#icon-trash"/></svg>
        ${_('Delete')}
      </button>`);
    }

    menu.innerHTML = items.join('');

    this.menuItemHandler = (action: string) => {
      switch (action) {
        case 'copy-permalink': {
          // Full URL (not bare naddr) so pasting into a browser address bar
          // opens the ticket via the /addons/feedback-board/:naddr route.
          const naddr = encodeNaddr({
            kind: FEEDBACK_CARD_KIND,
            pubkey: ticket.authorPubkey,
            identifier: ticket.dTag,
            relays: this.cardRelayHints(),
          });
          void ClipboardActionsService.getInstance().copyText(
            `${window.location.origin}/addons/feedback-board/${naddr}`,
            _('Permalink')
          );
          break;
        }
        case 'copy-event-id': {
          void ClipboardActionsService.getInstance().copyEventId(
            ticket.eventId,
            ticket.authorPubkey,
            this.cardRelayHints()
          );
          break;
        }
        case 'delete': {
          void this.confirmDelete(ticket);
          break;
        }
      }
    };

    menu.addEventListener('click', e => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(
        '.note-menu-item'
      );
      if (item?.dataset.action) {
        this.menuItemHandler?.(item.dataset.action);
        this.closeCardMenu();
      }
    });

    document.body.appendChild(menu);
    this.openCardMenu = menu;

    // Outside click closes the menu (registered on next tick so the opening
    // click doesn't hit it).
    this.cardMenuOutsideHandler = () => this.closeCardMenu();
    setTimeout(() => {
      document.addEventListener('click', this.cardMenuOutsideHandler!);
    }, 0);

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = triggerRect.bottom + 4;
    let left = triggerRect.right - menuRect.width;
    if (top + menuRect.height > window.innerHeight) {
      top = triggerRect.top - menuRect.height - 4;
    }
    if (left < 0) left = triggerRect.left;
    menu.style.position = 'fixed';
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.zIndex = '1000';
  }

  private menuItemHandler: ((action: string) => void) | null = null;

  /**
   * Relay hints for copied naddr/nevent links: the user's write relays,
   * capped. Without hints foreign clients (kanbanstr) can't resolve the
   * event — the relays carry the actual data.
   */
  private cardRelayHints(): string[] {
    return capRelayHints([], RelayConfig.getInstance().getWriteRelays());
  }

  private closeCardMenu(): void {
    if (this.cardMenuOutsideHandler) {
      document.removeEventListener('click', this.cardMenuOutsideHandler);
      this.cardMenuOutsideHandler = null;
    }
    if (this.openCardMenu) {
      this.openCardMenu.remove();
      this.openCardMenu = null;
      this.menuItemHandler = null;
    }
  }

  private renderCard(ticket: FeedbackTicket, isDev: boolean): string {
    const comments = this.service.getComments(this.state!, ticket.dTag);
    const withdrawn = ticket.status === 'withdrawn';
    const typeLabel = this.typeLabel(ticket.type);
    return `
      <div class="feedback-board__card${withdrawn ? ' feedback-board__card--withdrawn' : ''}"
           data-ticket="${escapeHtml(ticket.dTag)}">
        <div class="feedback-board__card-head">
          <a class="feedback-board__card-author" href="/profile/${hexToNpub(ticket.authorPubkey)}">${escapeHtml(this.usernameFor(ticket.authorPubkey))}</a>
          <span class="feedback-board__card-time">${formatTimeAgo(ticket.createdAt * 1000)}</span>
          <button class="note-menu-trigger" data-card-menu-trigger aria-label="${_('Card options')}"><svg width="16" height="16"><use href="#icon-menu-dots"/></svg></button>
        </div>
        ${typeLabel ? `<div class="feedback-board__card-type">${typeLabel}</div>` : ''}
        <h2 class="feedback-board__card-title">${escapeHtml(ticket.title)}</h2>
        ${ticket.description ? `<p class="feedback-board__card-snippet">${escapeHtml(ticket.description.slice(0, 120))}</p>` : ''}
        <div class="feedback-board__card-meta">
          ${withdrawn ? `<span class="badge badge--warning">${_('Withdrawn')}</span>` : ''}
          <span class="feedback-board__card-comments">${tn('%s comment', '%s comments', comments.length)}</span>
          ${isDev && ticket.status === 'done' ? `<button class="btn btn--mini btn--passive" data-card-action="archive">${_('Archive')}</button>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Withdrawn cards are not a column (no `col` entry on the board event —
   * foreign clients would park them in "unknown"). They render dimmed below
   * the board for every viewer, like before.
   */
  private renderWithdrawn(withdrawn: FeedbackTicket[]): string {
    const cards = withdrawn
      .map(t => this.renderCard(t, this.service.isDev()))
      .join('');
    return `
      <div class="feedback-board__withdrawn" data-withdrawn>
        <h2 class="h6">${_('Withdrawn')} (${withdrawn.length})</h2>
        <div class="feedback-board__cards">${cards}</div>
      </div>
    `;
  }

  private renderArchive(archived: FeedbackTicket[]): string {
    const items = archived
      .map(
        t => `
        <div class="ui-list__item ui-list__item--clickable" data-ticket="${escapeHtml(t.dTag)}">
          <div class="feedback-board__archive-info">
            <div class="feedback-board__card-title">${escapeHtml(t.title)}</div>
            <span class="feedback-board__card-time">${t.archivedAt ? formatTimeAgo(t.archivedAt * 1000) : ''}</span>
          </div>
        </div>`
      )
      .join('');

    return `
      <div class="nn-ui-toggle feedback-board__archive">
        <div class="nn-ui-toggle__header" data-archive-toggle>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${_('Archive')} (${archived.length})</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="${_('Toggle section')}">
            <svg width="20" height="20"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${archived.length ? `<div class="ui-list">${items}</div>` : `<p class="form__note">${_('No archived tickets yet.')}</p>`}
        </div>
      </div>
    `;
  }

  private wireCardHandlers(root: HTMLElement): void {
    root
      .querySelectorAll<HTMLElement>('.feedback-board__card')
      .forEach(card => {
        card.addEventListener('click', event => {
          const target = event.target as HTMLElement;
          // The dev's inline archive button must not open the detail modal.
          if (target.closest('[data-card-action="archive"]')) return;
          // Author links navigate via the global internal-link handler.
          if (target.closest('a')) return;
          // The 3-dot trigger opens the card menu instead of the modal.
          const menuTrigger = target.closest<HTMLElement>(
            '[data-card-menu-trigger]'
          );
          if (menuTrigger) {
            event.stopPropagation();
            const dTag = card.dataset.ticket;
            const ticket = this.state?.tickets.find(t => t.dTag === dTag);
            if (ticket) this.toggleCardMenu(menuTrigger, ticket);
            return;
          }
          const dTag = card.dataset.ticket;
          const ticket = this.state?.tickets.find(t => t.dTag === dTag);
          if (ticket) void this.openTicketModal(ticket);
        });
      });

    root
      .querySelectorAll<HTMLButtonElement>('[data-card-action="archive"]')
      .forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const dTag = (event.target as HTMLElement).closest<HTMLElement>(
            '[data-ticket]'
          )?.dataset.ticket;
          const ticket = this.state?.tickets.find(t => t.dTag === dTag);
          if (ticket) void this.archive(ticket);
        });
      });

    // Ticket rows inside the archive list also open the detail modal.
    root
      .querySelectorAll<HTMLElement>('.feedback-board__archive .ui-list__item')
      .forEach(item => {
        item.addEventListener('click', () => {
          const dTag = item.dataset.ticket;
          const ticket = this.state?.tickets.find(t => t.dTag === dTag);
          if (ticket) void this.openTicketModal(ticket);
        });
      });

    root
      .querySelector('[data-archive-toggle]')
      ?.addEventListener('click', () => {
        const toggle = root.querySelector('[data-archive-toggle]');
        const section = toggle?.closest('.nn-ui-toggle');
        section?.classList.toggle('open');
      });
  }

  /**
   * Optimistic archive: the ticket moves into the dev's archive section
   * instantly; the publish runs detached and rollback restores the card.
   */
  private async archive(ticket: FeedbackTicket): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: _('Archive ticket'),
      message: _(
        'Archived tickets stay visible to you only. Archive "%s"?'
      ).replace('%s', ticket.title),
      confirmText: _('Archive'),
      confirmDestructive: true,
    });
    if (!confirmed) return;

    const accepted = this.service.archiveTicket(ticket, () => {
      ticket.archived = false;
      delete ticket.archivedAt;
      ToastService.show(_('Publishing failed — try again.'), 'error');
      this.renderBoard();
    });
    if (!accepted) {
      ToastService.show(_('Publishing failed — try again.'), 'error');
      return;
    }

    ticket.archived = true;
    ticket.archivedAt = Math.floor(Date.now() / 1000);
    ToastService.show(_('Ticket archived'), 'success');
    this.renderBoard();
  }

  private openNewTicketModal(): void {
    const content = document.createElement('div');
    content.innerHTML = `
      <div class="form__row">
        <label for="fb-ticket-title">${_('Title')}</label>
        <input id="fb-ticket-title" class="input" type="text" maxlength="100" />
      </div>
      <div class="form__row">
        <label for="fb-ticket-type">${_('Type')}</label>
        <div data-type-dropdown></div>
      </div>
      <div class="form__row">
        <label for="fb-ticket-desc">${_('Description')}</label>
        <textarea id="fb-ticket-desc" class="textarea" rows="5" maxlength="2000"></textarea>
        <p class="form__note">${_('Tickets are public Nostr events — visible in every Nostr client (kanbanstr-compatible), not only in NoorNote. Do not include private data.')}</p>
      </div>
      <div class="l-row--end-pair">
        <button class="btn btn--passive btn--medium" data-cancel>${_('Cancel')}</button>
        <button class="btn btn--medium" data-submit>${_('Post Ticket')}</button>
      </div>
    `;

    this.typeDropdown = new NnDropdown({
      options: FEEDBACK_TICKET_TYPES.map(type => ({
        value: type,
        label: this.typeLabel(type),
      })),
      selectedValue: 'wish',
      onChange: () => {},
      menuPortal: false,
    });
    content
      .querySelector('[data-type-dropdown]')
      ?.appendChild(this.typeDropdown.getElement());

    const modal = ModalService.getInstance();
    content
      .querySelector('[data-cancel]')
      ?.addEventListener('click', () => modal.hide());
    content
      .querySelector('[data-submit]')
      ?.addEventListener('click', () => this.submitNewTicket(content));

    modal.show({ title: _('New Ticket'), content, width: '40%' });
  }

  /**
   * Optimistic create: the ticket appears instantly via the service's
   * pending-tickets overlay; publish runs detached and the rollback removes
   * the card if the relays never confirm.
   */
  private submitNewTicket(content: HTMLElement): void {
    const submitButton =
      content.querySelector<HTMLButtonElement>('[data-submit]');
    if (submitButton?.disabled) return;
    const title = (
      content.querySelector<HTMLInputElement>('#fb-ticket-title')?.value ?? ''
    ).trim();
    const description = (
      content.querySelector<HTMLTextAreaElement>('#fb-ticket-desc')?.value ?? ''
    ).trim();
    const type =
      (this.typeDropdown?.getValue() as FeedbackTicketType) ?? 'wish';

    if (!title) {
      ToastService.show(_('A title is required.'), 'warning');
      return;
    }

    const ticket = this.service.createTicket(title, description, type, () => {
      if (this.state) {
        this.state.tickets = this.state.tickets.filter(
          t => t.dTag !== ticket?.dTag
        );
      }
      ToastService.show(_('Publishing failed — try again.'), 'error');
      this.renderBoard();
    });
    if (!ticket) {
      ToastService.show(_('Publishing failed — try again.'), 'error');
      return;
    }

    if (this.state) {
      this.state.tickets.unshift(ticket);
    }
    ToastService.show(_('Ticket posted to the board'), 'success');
    ModalService.getInstance().hide();
    this.renderBoard();
  }

  private async openTicketModal(ticket: FeedbackTicket): Promise<void> {
    const isDev = this.service.isDev();
    const currentUserPubkey = this.service.currentPubkey();
    const isAuthor = currentUserPubkey === ticket.authorPubkey;
    // Viewer context for the per-item delete buttons (post vs. comments).
    const viewer = { isDev, pubkey: currentUserPubkey };
    const comments = this.service.getComments(this.state!, ticket.dTag);
    const modal = ModalService.getInstance();

    const commentsHtml = comments
      .map(c => this.commentHtml(c, viewer))
      .join('');

    // Dev moves between the three columns; the author may only withdraw.
    const moveControls = isDev
      ? `
      <div class="form__row feedback-board__move-row">
        <label>${_('Move to')}</label>
        <div class="feedback-board__move">
          ${FEEDBACK_COLUMNS.filter(s => s !== ticket.status)
            .map(
              s =>
                `<button class="btn btn--passive btn--mini" data-move="${s}">${this.service.statusLabel(s as FeedbackTicketStatus)}</button>`
            )
            .join('')}
        </div>
      </div>`
      : isAuthor && ticket.status !== 'withdrawn'
        ? `<div class="l-row--right feedback-board__move-row"><button class="btn btn--passive btn--mini" data-move="withdrawn">${_('Withdraw Ticket')}</button></div>`
        : '';

    const content = document.createElement('div');
    content.innerHTML = `
      <p class="feedback-board__detail-desc">${escapeHtml(ticket.description)}</p>
      <div class="feedback-board__comments">${commentsHtml}</div>
      ${moveControls}
      <div class="form__row">
        <label for="fb-comment">${_('Add comment')}</label>
        <textarea id="fb-comment" class="textarea textarea--small" rows="3" maxlength="1000"></textarea>
      </div>
      <div class="l-row--right">
        <button class="btn btn--medium" data-send-comment>${_('Comment')}</button>
      </div>
    `;

    content
      .querySelectorAll<HTMLButtonElement>('[data-move]')
      .forEach(button => {
        button.addEventListener('click', () => {
          const target = button.dataset.move as FeedbackTicketStatus;
          this.moveTicket(ticket, target);
        });
      });
    // Delegation on the modal content: the comment list is re-rendered
    // optimistically, per-button listeners would be lost on refresh.
    content.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-del-comment]'
      );
      if (!button) return;
      const comment = this.service
        .getComments(this.state!, ticket.dTag)
        .find(c => c.eventId === button.dataset.delComment);
      if (comment) {
        void this.confirmDeleteComment(
          comment,
          ticket.dTag,
          content.querySelector<HTMLElement>('.feedback-board__comments'),
          viewer
        );
      }
    });
    content
      .querySelector('[data-send-comment]')
      ?.addEventListener('click', () => {
        const textarea =
          content.querySelector<HTMLTextAreaElement>('#fb-comment');
        const text = (textarea?.value ?? '').trim();
        if (!text) return;
        this.sendComment(
          ticket,
          text,
          content.querySelector<HTMLElement>('.feedback-board__comments'),
          textarea!
        );
      });

    modal.show({
      title: ticket.title,
      content,
      width: '45%',
    });
  }

  /**
   * Optimistic delete: remove the card from the local state instantly, publish
   * the NIP-09 event detached. On relay failure the rollback callback puts the
   * card back and the error toast fires.
   */
  private async confirmDelete(ticket: FeedbackTicket): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: _('Delete ticket'),
      message: _(
        'The ticket and all its comments will be removed from relays that honor NIP-09. Copies may persist elsewhere. Delete "%s"?'
      ).replace('%s', ticket.title),
      confirmText: _('Delete'),
      confirmDestructive: true,
    });
    if (!confirmed) return;

    // One kind-5 deletes the ticket AND every comment under it — no
    // orphaned comment threads left on relays. Pending local comments
    // (`local-` temp ids) have no real event id yet and are skipped; their
    // own publish either succeeds independently or rolls itself back.
    const commentIds = this.service
      .getComments(this.state!, ticket.dTag)
      .map(c => c.eventId)
      .filter(id => id && !id.startsWith('local-'));

    const accepted = this.service.deleteTicket(ticket, commentIds, () => {
      if (this.state) {
        this.state.tickets.push(ticket);
        this.state.tickets.sort((a, b) => b.createdAt - a.createdAt);
      }
      ToastService.show(_('Publishing failed — try again.'), 'error');
      this.renderBoard();
    });
    if (!accepted) {
      ToastService.show(_('Publishing failed — try again.'), 'error');
      return;
    }

    if (this.state) {
      this.state.tickets = this.state.tickets.filter(
        t => t.dTag !== ticket.dTag
      );
    }
    ToastService.show(_('Ticket deleted'), 'success');
    ModalService.getInstance().hide();
    this.renderBoard();
  }

  /**
   * Optimistic move: apply the status to the local state and re-render
   * instantly. The service publishes detached; on relay failure the rollback
   * callback reverts the card and the error toast fires.
   */
  private moveTicket(
    ticket: FeedbackTicket,
    target: FeedbackTicketStatus
  ): void {
    const previous = ticket.status;
    const accepted = this.service.setStatus(ticket, target, () => {
      this.applyLocalStatus(ticket.dTag, previous);
      ToastService.show(_('Publishing failed — try again.'), 'error');
    });
    if (!accepted) {
      ToastService.show(_('Publishing failed — try again.'), 'error');
      return;
    }
    ToastService.show(_('Ticket updated'), 'success');
    ModalService.getInstance().hide();
    this.applyLocalStatus(ticket.dTag, target);
  }

  /** Mutate one ticket's status in the cached board state and re-render. */
  private applyLocalStatus(dTag: string, status: FeedbackTicketStatus): void {
    const ticket = this.state?.tickets.find(t => t.dTag === dTag);
    if (ticket) {
      ticket.status = status;
    }
    this.renderBoard();
  }

  /**
   * One comment row in the detail modal (shared by initial render and the
   * optimistic live-append). The optional delete button sits INSIDE the text
   * block it deletes, so its target is unambiguous.
   */
  private commentHtml(
    c: FeedbackComment,
    viewer: { isDev: boolean; pubkey: string }
  ): string {
    const byDev = isDevPubkey(c.pubkey);
    const canDelete =
      (viewer.isDev || c.pubkey === viewer.pubkey) &&
      !c.eventId.startsWith('local-');
    const deleteBtn = canDelete
      ? `<button class="feedback-board__inline-delete" data-del-comment="${escapeHtml(c.eventId)}">${_('Delete')}</button>`
      : '';
    return `
      <div class="feedback-board__comment">
        <div class="feedback-board__comment-head">
          <span class="feedback-board__card-author${byDev ? ' feedback-board__card-author--dev' : ''}">${escapeHtml(this.usernameFor(c.pubkey))}</span>
          <span class="feedback-board__card-time">${c.createdAt ? formatTimeAgo(c.createdAt * 1000) : ''}</span>
        </div>
        <p class="feedback-board__comment-text">${escapeHtml(c.content)}${deleteBtn}</p>
      </div>
    `;
  }

  /** Re-render the modal's comment list from the (overlay-merged) state. */
  private refreshModalComments(
    listEl: HTMLElement | null,
    dTag: string,
    viewer: { isDev: boolean; pubkey: string }
  ): void {
    if (!listEl) return;
    listEl.innerHTML = this.service
      .getComments(this.state!, dTag)
      .map(c => this.commentHtml(c, viewer))
      .join('');
  }

  /**
   * Optimistic comment delete: the entry vanishes from the open modal
   * instantly (service overlay), the NIP-09 event publishes detached. On
   * relay failure the rollback re-renders the list with the comment back.
   */
  private async confirmDeleteComment(
    comment: FeedbackComment,
    dTag: string,
    listEl: HTMLElement | null,
    viewer: { isDev: boolean; pubkey: string }
  ): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: _('Delete comment'),
      message: _(
        'The comment will be removed from relays that honor NIP-09. Delete it?'
      ),
      confirmText: _('Delete'),
      confirmDestructive: true,
    });
    if (!confirmed) return;

    const accepted = this.service.deleteComment(comment, () => {
      ToastService.show(_('Publishing failed — try again.'), 'error');
      this.refreshModalComments(listEl, dTag, viewer);
    });
    if (!accepted) {
      ToastService.show(_('Publishing failed — try again.'), 'error');
      return;
    }
    ToastService.show(_('Comment deleted'), 'success');
    this.refreshModalComments(listEl, dTag, viewer);
    this.renderBoard();
  }

  /**
   * Optimistic comment: the entry appears instantly in the open modal (and the
   * card counter), the publish runs detached. On relay failure the service
   * drops the pending entry and the rollback re-renders without it.
   */
  private sendComment(
    ticket: FeedbackTicket,
    text: string,
    listEl: HTMLElement | null,
    textarea: HTMLTextAreaElement
  ): void {
    const viewer = {
      isDev: this.service.isDev(),
      pubkey: this.service.currentPubkey(),
    };
    const accepted = this.service.addComment(ticket, text, () => {
      ToastService.show(_('Publishing failed — try again.'), 'error');
      this.refreshModalComments(listEl, ticket.dTag, viewer);
      this.renderBoard();
    });
    if (!accepted) {
      ToastService.show(_('Publishing failed — try again.'), 'error');
      return;
    }
    ToastService.show(_('Comment sent'), 'success');
    textarea.value = '';
    this.refreshModalComments(listEl, ticket.dTag, viewer);
    this.renderBoard();
  }
}
