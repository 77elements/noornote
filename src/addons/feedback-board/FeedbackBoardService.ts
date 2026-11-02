/**
 * Feedback Board service — public ticket board between users and the developer.
 *
 * Storage model (public by design, see docs/todos/feedback-board.md):
 *  - kind 39100: the ticket, published by its author (addressable via d-tag).
 *  - kind 39101: an action on a ticket (comment / status / archive), published
 *    by whoever acts. Status changes and archiving are ACTION events, never
 *    edits of the author's ticket event — the author stays the sole owner of
 *    the 39100 event.
 *
 * Every action DMs the other side (dev ↔ ticket author) via the existing
 * NIP-17 path in DMService. The DM is a pointer; the board content is public.
 */

import { NostrEvent, type NDKKind } from '@nostr-dev-kit/ndk';
import { AuthService } from '../../services/AuthService';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { DMService } from '../../services/dm/DMService';
import { diagLog } from '../../services/DiagnosticLogger';
import { SystemLogger } from '../../services/SystemLogger';
import { errMessage } from '../../helpers/errorMessage';
import { getTag } from '../../helpers/tagUtils';
import { _ } from '../../i18n';
import {
  FEEDBACK_ACTION_KIND,
  FEEDBACK_DELETE_KIND,
  FEEDBACK_DEV_PUBKEY,
  FEEDBACK_DTAG_PREFIX,
  FEEDBACK_STATUSES,
  FEEDBACK_TICKET_KIND,
  FEEDBACK_TICKET_TYPES,
  type FeedbackActionType,
  type FeedbackTicket,
  type FeedbackTicketStatus,
  type FeedbackTicketType,
  parseTicketAddress,
  ticketAddress,
} from './feedbackBoardConstants';

export interface FeedbackComment {
  eventId: string;
  pubkey: string;
  content: string;
  createdAt: number;
}

export interface FeedbackBoardState {
  tickets: FeedbackTicket[];
  comments: Map<string, FeedbackComment[]>;
}

export function isDevPubkey(pubkey: string | undefined): boolean {
  return !!pubkey && pubkey === FEEDBACK_DEV_PUBKEY;
}

/** getTag wrapper that reports missing tags as undefined instead of ''. */
function firstTag(event: NostrEvent, name: string): string | undefined {
  const value = getTag(event.tags, name);
  return value === '' ? undefined : value;
}

export class FeedbackBoardService {
  private static instance: FeedbackBoardService | null = null;
  private authService: AuthService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private seenActionEventIds = new Set<string>();
  /**
   * Local overlay for just-published actions. Relay propagation is slower than
   * the board refresh that follows a publish — the overlay applies the actor's
   * own action immediately and is dropped once the relay state matches.
   */
  private pendingStatus = new Map<string, FeedbackTicketStatus>();
  private pendingArchived = new Set<string>();
  private pendingComments = new Map<string, FeedbackComment[]>();
  private lastPublishedActionId = '';
  /**
   * Tickets hidden via local overlay after an optimistic NIP-09 delete.
   * Entries stay until the session ends — a relay that ignores NIP-09 keeps
   * returning the ticket event, and the overlay keeps hiding it here.
   */
  private pendingDeleted = new Set<string>();
  /**
   * Comment event ids hidden via local overlay after an optimistic NIP-09
   * delete. Confirmed entries are dropped once the reducer sees the deletion
   * on the relay side.
   */
  private pendingDeletedComments = new Set<string>();
  /** Optimistically created tickets — shown until the relays catch up. */
  private pendingTickets = new Map<string, FeedbackTicket>();

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): FeedbackBoardService {
    if (!FeedbackBoardService.instance) {
      FeedbackBoardService.instance = new FeedbackBoardService();
    }
    return FeedbackBoardService.instance;
  }

  /** Reset for tests / account switches. */
  public static resetInstance(): void {
    FeedbackBoardService.instance = null;
  }

  public isDev(): boolean {
    return isDevPubkey(this.authService.getCurrentUser()?.pubkey);
  }

  /**
   * Fetch the full public board (tickets + actions) and reduce it to state.
   * Archived tickets come back with `archived: true` — the renderer decides
   * visibility (dev-only archive section).
   */
  public async loadBoard(): Promise<FeedbackBoardState> {
    const relays = this.relayConfig.getReadRelays();
    const events = await this.transport.fetchDirect(
      relays,
      [
        {
          kinds: [
            FEEDBACK_TICKET_KIND,
            FEEDBACK_ACTION_KIND,
          ] as unknown as NDKKind[],
          limit: 500,
        },
      ],
      10000,
      'feedback-board',
      // Wait for every relay to EOSE — a first-relay return regularly missed
      // archive/status action events stored on slower relays, which made the
      // board state flicker between refreshes.
      true
    );

    const tickets = new Map<string, FeedbackTicket>();
    const actions: NostrEvent[] = [];

    for (const event of events) {
      if (event.kind === FEEDBACK_TICKET_KIND) {
        const ticket = this.parseTicket(event);
        if (ticket) {
          // Addressable semantics: newest event per d-tag wins.
          const existing = tickets.get(ticket.dTag);
          if (!existing || ticket.createdAt >= existing.createdAt) {
            tickets.set(ticket.dTag, ticket);
          }
        }
      } else if (event.kind === FEEDBACK_ACTION_KIND) {
        actions.push(event);
      }
    }

    const comments = new Map<string, FeedbackComment[]>();
    const statusActions = new Map<string, NostrEvent>();
    const archiveActions = new Map<string, NostrEvent>();

    for (const action of actions) {
      const address = firstTag(action, 'a');
      if (!address) continue;
      const ref = parseTicketAddress(address);
      // Actions referencing unknown tickets are ignored.
      if (!ref || !tickets.has(ref.dTag)) continue;

      const ticket = tickets.get(ref.dTag)!;
      const type = firstTag(action, 'type');
      const actor = action.pubkey;
      const actorIsDev = isDevPubkey(actor);
      const actorIsAuthor = actor === ticket.authorPubkey;
      const isNewer = (prev: NostrEvent | undefined) =>
        !prev || action.created_at >= prev.created_at;

      if (type === 'comment') {
        const list = comments.get(ref.dTag) ?? [];
        list.push({
          eventId: action.id ?? '',
          pubkey: actor,
          content: action.content,
          createdAt: action.created_at,
        });
        comments.set(ref.dTag, list);
      } else if (
        type === 'status' &&
        actorIsDev &&
        isNewer(statusActions.get(ref.dTag))
      ) {
        // Only the dev moves tickets between columns.
        statusActions.set(ref.dTag, action);
      } else if (
        type === 'status' &&
        actorIsAuthor &&
        firstTag(action, 'status') === 'withdrawn' &&
        isNewer(statusActions.get(ref.dTag))
      ) {
        // The author may only withdraw their own ticket.
        statusActions.set(ref.dTag, action);
      } else if (type === 'archive' && actorIsDev) {
        archiveActions.set(ref.dTag, action);
      }
    }

    for (const ticket of tickets.values()) {
      const statusAction = statusActions.get(ticket.dTag);
      if (statusAction) {
        const status = firstTag(statusAction, 'status');
        if (status && (FEEDBACK_STATUSES as string[]).includes(status)) {
          ticket.status = status as FeedbackTicketStatus;
        }
      }
      const archiveAction = archiveActions.get(ticket.dTag);
      ticket.archived = !!archiveAction;
      if (archiveAction) {
        ticket.archivedAt = archiveAction.created_at;
      }

      // Apply the local overlay; drop entries the relay state has caught up with.
      const pendingStatus = this.pendingStatus.get(ticket.dTag);
      if (pendingStatus) {
        if (pendingStatus === ticket.status) {
          this.pendingStatus.delete(ticket.dTag);
        } else {
          ticket.status = pendingStatus;
        }
      }
      if (this.pendingArchived.has(ticket.dTag)) {
        if (ticket.archived) {
          this.pendingArchived.delete(ticket.dTag);
        } else {
          ticket.archived = true;
        }
      }
      const pending = this.pendingComments.get(ticket.dTag);
      if (pending?.length) {
        const relayIds = new Set(
          (comments.get(ticket.dTag) ?? []).map(c => c.eventId)
        );
        const stillPending = pending.filter(c => !relayIds.has(c.eventId));
        if (stillPending.length === 0) {
          this.pendingComments.delete(ticket.dTag);
        } else {
          comments.set(
            ticket.dTag,
            [...(comments.get(ticket.dTag) ?? []), ...stillPending].sort(
              (a, b) => a.createdAt - b.createdAt
            )
          );
        }
      }
    }

    // Track seen action events so follow-up fetches never double-notify.
    for (const action of actions) {
      if (action.id) this.seenActionEventIds.add(action.id);
    }

    // NIP-09 deletion requests referencing our tickets or comments. Our
    // deletes always tag `e` (target event id), so `#e` is a precise, small
    // filter.
    const ticketIds = [...tickets.values()].map(t => t.eventId).filter(Boolean);
    const commentIds = [...comments.values()]
      .flat()
      .map(c => c.eventId)
      .filter(Boolean);
    if (ticketIds.length || commentIds.length) {
      const deletions = await this.transport.fetchDirect(
        relays,
        [
          {
            kinds: [FEEDBACK_DELETE_KIND as unknown as NDKKind],
            '#e': [...ticketIds, ...commentIds],
            limit: 500,
          },
        ],
        8000,
        'feedback-board-deletes',
        true
      );
      for (const deletion of deletions) {
        // Every `e` ref is checked against its target: tickets may be
        // deleted by their author or the dev, comments by their writer or
        // the dev.
        const eRefs = deletion.tags
          .filter(t => t[0] === 'e' && t[1])
          .map(t => t[1]);
        for (const eRef of eRefs) {
          const target = [...tickets.values()].find(t => t.eventId === eRef);
          if (target) {
            if (
              deletion.pubkey === target.authorPubkey ||
              isDevPubkey(deletion.pubkey)
            ) {
              tickets.delete(target.dTag);
            }
            continue;
          }
          for (const [dTag, list] of comments) {
            const removed = list.find(c => c.eventId === eRef);
            if (!removed) continue;
            if (
              deletion.pubkey === removed.pubkey ||
              isDevPubkey(deletion.pubkey)
            ) {
              list.splice(list.indexOf(removed), 1);
              if (!list.length) comments.delete(dTag);
            }
            break;
          }
        }
      }
    }

    // Overlay entries whose target is gone from the relay state (either the
    // deletion is now relay-verified or the comment vanished entirely) are
    // no longer needed.
    const outputCommentIds = new Set(
      [...comments.values()].flat().map(c => c.eventId)
    );
    for (const id of this.pendingDeletedComments) {
      if (!outputCommentIds.has(id)) {
        this.pendingDeletedComments.delete(id);
      }
    }

    // Optimistically hidden via local overlay (relays may ignore NIP-09).
    for (const dTag of this.pendingDeleted) {
      tickets.delete(dTag);
    }

    // Optimistically created tickets — shown until the relay state catches
    // up, then the overlay entry is dropped.
    for (const [dTag, pendingTicket] of this.pendingTickets) {
      if (tickets.has(dTag)) {
        this.pendingTickets.delete(dTag);
      } else {
        tickets.set(dTag, pendingTicket);
      }
    }

    const list = [...tickets.values()].sort(
      (a, b) => b.createdAt - a.createdAt
    );
    return { tickets: list, comments };
  }

  private parseTicket(event: NostrEvent): FeedbackTicket | null {
    const dTag = firstTag(event, 'd');
    if (!dTag || !dTag.startsWith(FEEDBACK_DTAG_PREFIX)) return null;

    const content = event.content ?? '';
    const newlineIndex = content.indexOf('\n');
    const title = (
      newlineIndex === -1 ? content : content.slice(0, newlineIndex)
    ).trim();
    const description =
      newlineIndex === -1 ? '' : content.slice(newlineIndex + 1).trim();
    if (!title) return null;

    const type = firstTag(event, 't') as FeedbackTicketType | undefined;
    const status = firstTag(event, 'status');

    const ticket: FeedbackTicket = {
      dTag,
      eventId: event.id ?? '',
      authorPubkey: event.pubkey,
      title,
      description,
      createdAt: event.created_at,
      status:
        status && (FEEDBACK_STATUSES as string[]).includes(status)
          ? (status as FeedbackTicketStatus)
          : 'backlog',
      archived: false,
    };
    if (type && (FEEDBACK_TICKET_TYPES as string[]).includes(type)) {
      ticket.type = type;
    }
    return ticket;
  }

  /**
   * Create a new ticket (any logged-in user) — optimistic. Returns the local
   * ticket immediately; it is held in `pendingTickets` so board fetches keep
   * showing it until the relays catch up. Rollback on publish failure.
   */
  public createTicket(
    title: string,
    description: string,
    type: FeedbackTicketType,
    onRollback: () => void
  ): FeedbackTicket | null {
    const current = this.authService.getCurrentUser();
    if (!current) return null;

    const dTag = `${FEEDBACK_DTAG_PREFIX}${Date.now()}`;
    const localTicket: FeedbackTicket = {
      dTag,
      eventId: '',
      authorPubkey: current.pubkey,
      title,
      description,
      createdAt: Math.floor(Date.now() / 1000),
      status: 'backlog',
      archived: false,
      type,
    };
    this.pendingTickets.set(dTag, localTicket);

    void (async () => {
      const event = await this.publish(
        FEEDBACK_TICKET_KIND,
        `${title}\n\n${description}`,
        [
          ['d', dTag],
          ['status', 'backlog'],
          ['t', type],
        ]
      );
      if (event) {
        localTicket.eventId = event.id ?? '';
        diagLog('system', 'Feedback ticket created', { dTag, type });
        const parsed = this.parseTicket(event);
        if (parsed) {
          await this.notifyOtherSide(
            parsed,
            _('New feedback board ticket: "%s"').replace('%s', parsed.title)
          );
        }
      } else {
        this.pendingTickets.delete(dTag);
        onRollback();
      }
    })();

    return localTicket;
  }

  /** Comment on a ticket (any logged-in user incl. dev) — optimistic. */
  public addComment(
    ticket: FeedbackTicket,
    text: string,
    onRollback: () => void
  ): boolean {
    const current = this.authService.getCurrentUser();
    if (!current) return false;

    // Optimistic entry with a temp id; replaced by the real event id once
    // signed so the relay-catchup dedup in loadBoard keeps working.
    const tempId = `local-${Date.now()}`;
    const entry: FeedbackComment = {
      eventId: tempId,
      pubkey: current.pubkey,
      content: text,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.pendingComments.set(ticket.dTag, [
      ...(this.pendingComments.get(ticket.dTag) ?? []),
      entry,
    ]);

    void (async () => {
      const ok = await this.publishAction(ticket, 'comment', text, undefined);
      if (ok) {
        entry.eventId = this.lastPublishedActionId;
        await this.notifyOtherSide(
          ticket,
          _('New comment on "%s": %s')
            .replace('%s', ticket.title)
            .replace('%s', text.slice(0, 80))
        );
      } else {
        // Drop the optimistic entry — the view's rollback reverts the UI.
        const list = this.pendingComments.get(ticket.dTag) ?? [];
        this.pendingComments.set(
          ticket.dTag,
          list.filter(c => c.eventId !== tempId)
        );
        onRollback();
      }
    })();

    return true;
  }

  /**
   * Change the ticket status — optimistic. The move is applied instantly via
   * the local overlay (no fetch, no relay wait); the publish runs detached.
   * If the relay confirmation fails (no acks / 15 s timeout), the overlay
   * entry is dropped and onRollback fires so the view can revert the card.
   * Dev may move freely; the author may only withdraw their own ticket.
   */
  public setStatus(
    ticket: FeedbackTicket,
    status: FeedbackTicketStatus,
    onRollback: () => void
  ): boolean {
    const current = this.authService.getCurrentUser();
    if (!current) return false;

    const isAuthor = current.pubkey === ticket.authorPubkey;
    if (!this.isDev() && !(isAuthor && status === 'withdrawn')) {
      return false;
    }

    this.pendingStatus.set(ticket.dTag, status);

    void (async () => {
      const ok = await this.publishAction(ticket, 'status', '', status);
      if (ok) {
        diagLog('system', 'Feedback ticket status changed', {
          dTag: ticket.dTag,
          status,
        });
        await this.notifyOtherSide(
          ticket,
          _('Status update for "%s": %s')
            .replace('%s', ticket.title)
            .replace('%s', this.statusLabel(status))
        );
      } else {
        this.pendingStatus.delete(ticket.dTag);
        onRollback();
      }
    })();

    return true;
  }

  /**
   * Archive a ticket (dev only) — optimistic, like setStatus. The overlay
   * hides it instantly; rollback restores if the publish fails.
   */
  public archiveTicket(
    ticket: FeedbackTicket,
    onRollback: () => void
  ): boolean {
    if (!this.isDev()) return false;

    this.pendingArchived.add(ticket.dTag);

    void (async () => {
      const ok = await this.publishAction(ticket, 'archive', '', undefined);
      if (ok) {
        diagLog('system', 'Feedback ticket archived', { dTag: ticket.dTag });
        await this.notifyOtherSide(
          ticket,
          _('Ticket "%s" was archived').replace('%s', ticket.title)
        );
      } else {
        this.pendingArchived.delete(ticket.dTag);
        onRollback();
      }
    })();

    return true;
  }

  /**
   * Delete a ticket via NIP-09 (kind 5) — optimistic, like setStatus. The
   * author may delete their own ticket, the dev may delete any ticket. The
   * delete event tags `a` (address) + `e` for the ticket AND one `e` per
   * comment, so relays honoring NIP-09 also drop the comment thread — no
   * orphaned comments left behind. The read side of loadBoard picks kind-5
   * events up and filters ticket and comments out.
   */
  public deleteTicket(
    ticket: FeedbackTicket,
    commentEventIds: string[],
    onRollback: () => void
  ): boolean {
    const current = this.authService.getCurrentUser();
    if (!current) return false;

    const isAuthor = current.pubkey === ticket.authorPubkey;
    if (!this.isDev() && !isAuthor) return false;

    this.pendingDeleted.add(ticket.dTag);

    void (async () => {
      const event = await this.publish(FEEDBACK_DELETE_KIND, '', [
        ['a', ticketAddress(ticket.authorPubkey, ticket.dTag)],
        ['e', ticket.eventId],
        ...commentEventIds.map(id => ['e', id]),
      ] as string[][]);
      if (event) {
        diagLog('system', 'Feedback ticket deleted', { dTag: ticket.dTag });
      } else {
        this.pendingDeleted.delete(ticket.dTag);
        onRollback();
      }
    })();

    return true;
  }

  /**
   * Delete a single comment via NIP-09 (kind 5) — optimistic. The comment's
   * writer or the dev may delete it; the delete event tags only `e` (the
   * comment event id), so the original ticket stays untouched.
   */
  public deleteComment(
    comment: FeedbackComment,
    onRollback: () => void
  ): boolean {
    const current = this.authService.getCurrentUser();
    if (!current) return false;
    if (!this.isDev() && current.pubkey !== comment.pubkey) return false;

    this.pendingDeletedComments.add(comment.eventId);

    void (async () => {
      const event = await this.publish(FEEDBACK_DELETE_KIND, '', [
        ['e', comment.eventId],
      ]);
      if (event) {
        diagLog('system', 'Feedback comment deleted', {
          eventId: comment.eventId,
        });
      } else {
        this.pendingDeletedComments.delete(comment.eventId);
        onRollback();
      }
    })();

    return true;
  }

  public statusLabel(status: FeedbackTicketStatus): string {
    switch (status) {
      case 'backlog':
        return _('Backlog');
      case 'wip':
        return _('In Progress');
      case 'done':
        return _('Done');
      case 'withdrawn':
        return _('Withdrawn');
    }
  }

  /**
   * The other side of the actor: dev acts → author gets the DM,
   * anyone else acts → dev gets the DM.
   */
  /**
   * Comments for a ticket — relay state plus optimistic pending entries, so a
   * just-written comment is visible in every state snapshot immediately.
   */
  public getComments(
    state: FeedbackBoardState,
    dTag: string
  ): FeedbackComment[] {
    const relay = (state.comments.get(dTag) ?? []).filter(
      c => !this.pendingDeletedComments.has(c.eventId)
    );
    const pending = this.pendingComments.get(dTag) ?? [];
    if (!pending.length) return relay;
    const relayIds = new Set(relay.map(c => c.eventId));
    return [...relay, ...pending.filter(c => !relayIds.has(c.eventId))];
  }

  private async notifyOtherSide(
    ticket: FeedbackTicket,
    reason: string
  ): Promise<void> {
    const current = this.authService.getCurrentUser();
    if (!current) return;

    const recipient = isDevPubkey(current.pubkey)
      ? ticket.authorPubkey
      : FEEDBACK_DEV_PUBKEY;
    await this.sendDM(
      recipient,
      `${reason} — ${_('Only readable in NoorNote.')}`
    );
  }

  /**
   * NIP-17 DM via the existing DMService pipeline. Arrival already triggers
   * the standard in-app notification (toast + sidebar badge) on the recipient
   * — the DM is both the notification and the pointer to the board.
   */
  private async sendDM(
    recipientPubkey: string,
    content: string
  ): Promise<void> {
    try {
      const ok = await DMService.getInstance().sendMessage(
        recipientPubkey,
        content
      );
      if (!ok) {
        diagLog('system', 'Feedback board DM failed', {
          to: recipientPubkey.slice(0, 8),
        });
      }
    } catch (error) {
      diagLog('system', 'Feedback board DM error', {
        error: errMessage(error),
      });
    }
  }

  private async publishAction(
    ticket: FeedbackTicket,
    type: FeedbackActionType,
    content: string,
    status: FeedbackTicketStatus | undefined
  ): Promise<boolean> {
    const current = this.authService.getCurrentUser();
    if (!current) return false;

    const otherSide = isDevPubkey(current.pubkey)
      ? ticket.authorPubkey
      : FEEDBACK_DEV_PUBKEY;

    const tags: string[][] = [
      ['a', ticketAddress(ticket.authorPubkey, ticket.dTag)],
      ['e', ticket.eventId],
      ['type', type],
      ['p', otherSide],
    ];
    if (status) {
      tags.push(['status', status]);
    }
    const event = await this.publish(FEEDBACK_ACTION_KIND, content, tags);
    if (event?.id) {
      this.seenActionEventIds.add(event.id);
      this.lastPublishedActionId = event.id;
    }
    return !!event;
  }

  private async publish(
    kind: number,
    content: string,
    tags: string[][]
  ): Promise<NostrEvent | null> {
    const current = this.authService.getCurrentUser();
    if (!current) return null;

    const unsigned = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
      pubkey: current.pubkey,
    };
    try {
      // Hard 15 s guard around SIGNING and publishing: NDK publish can hang
      // past its own per-relay timeout when relays never connect, and a
      // NIP-07 signer can hang on a lost connection. The optimistic UI needs
      // a definite answer either way. Work that lands after the timeout is
      // harmless — the event is self-verifying relay state and shows up in
      // the next board fetch.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('publish-timeout')), 15000);
      });
      try {
        const signed = await Promise.race([
          this.authService.signEvent(unsigned),
          timeout,
        ]);
        if (!signed) {
          this.systemLogger.error('FeedbackBoard', 'Could not sign event');
          return null;
        }
        await Promise.race([
          this.transport.publish(this.relayConfig.getWriteRelays(), signed),
          timeout,
        ]);
        return signed;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      diagLog('system', 'Feedback board publish failed', {
        error: errMessage(error),
      });
      this.systemLogger.error('FeedbackBoard', 'Publishing failed — try again');
      return null;
    }
  }
}
