/**
 * Feedback Board service — public kanbanstr-compatible ticket board
 * (NIP-100 draft: kinds 30301 board / 30302 card, NIP-22 kind-1111 comments)
 * between users and the developer. See docs/todos/feedback-board.md.
 *
 * Storage model (public by design):
 *  - kind 30301: the board definition, owned by the dev account. The board
 *    address `30301:<dev>:noornote-feedback` is the addon's namespace marker —
 *    only cards whose `a` tag references it are fetched and shown.
 *  - kind 30302: a ticket card, published by its author. Status moves, edits
 *    and archiving are republishes of the card with the same `d` (NIP-100
 *    fold: latest event by the board creator or the original author wins).
 *    Every publisher carries the current values forward, so the fold is a
 *    simple latest-wins over eligible events (see feedbackBoardReducer).
 *  - kind 1111: NIP-22 comments, append-only — they can never be overwritten
 *    by a later event (the bug class that killed comments in the legacy
 *    replaceable 39101 model).
 *  - kind 5: NIP-09 deletions (ticket + comment thread / single comment).
 *
 * Every action DMs the other side (dev ↔ ticket author) via the dms module
 * API. The DM is a pointer; the board content is public.
 */

import { NostrEvent, type NDKFilter, type NDKKind } from '@nostr-dev-kit/ndk';
import { AuthService } from '../../services/AuthService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { DMsModuleApi } from '../../modules/dms/contracts';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { diagLog } from '../../services/DiagnosticLogger';
import { SystemLogger } from '../../services/SystemLogger';
import { errMessage } from '../../helpers/errorMessage';
import { getZapAmountSats } from '../../helpers/zapUtils';
import { _ } from '../../i18n';
import {
  FEEDBACK_BOARD_KIND,
  FEEDBACK_BOARD_DTAG,
  FEEDBACK_CARD_KIND,
  FEEDBACK_COMMENT_KIND,
  FEEDBACK_DELETE_KIND,
  FEEDBACK_DEV_PUBKEY,
  FEEDBACK_DTAG_PREFIX,
  boardAddress,
  cardAddress,
  statusToS,
  type FeedbackTicket,
  type FeedbackTicketStatus,
  type FeedbackTicketType,
} from './feedbackBoardConstants';
import {
  applyDeletions,
  buildComments,
  cardCoordinates,
  foldCards,
  type FeedbackBoardState,
  type FeedbackComment,
} from './feedbackBoardReducer';

export type {
  FeedbackBoardState,
  FeedbackComment,
} from './feedbackBoardReducer';

export function isDevPubkey(pubkey: string | undefined): boolean {
  return !!pubkey && pubkey === FEEDBACK_DEV_PUBKEY;
}

export class FeedbackBoardService {
  private static instance: FeedbackBoardService | null = null;
  private authService: AuthService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  /**
   * Local overlay for just-published moves. Relay propagation is slower than
   * the board refresh that follows a publish — the overlay applies the
   * actor's own action immediately and is dropped once the relay state
   * matches.
   */
  private pendingStatus = new Map<string, FeedbackTicketStatus>();
  private pendingArchived = new Set<string>();
  private pendingComments = new Map<string, FeedbackComment[]>();
  private lastPublishedCommentId = '';
  /**
   * Cards hidden via local overlay after an optimistic NIP-09 delete.
   * Entries stay until the session ends — a relay that ignores NIP-09 keeps
   * returning the card event, and the overlay keeps hiding it here.
   */
  private pendingDeleted = new Set<string>();
  /**
   * Comment event ids hidden via local overlay after an optimistic NIP-09
   * delete. Confirmed entries are dropped once the reducer sees the deletion
   * on the relay side.
   */
  private pendingDeletedComments = new Set<string>();
  /** Optimistically created cards — shown until the relays catch up. */
  private pendingTickets = new Map<string, FeedbackTicket>();
  /**
   * Last fully loaded board state — painted instantly on re-open while a
   * background refresh reconciles it (stale-while-revalidate).
   */
  private cachedState: FeedbackBoardState | null = null;

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

  /** Current user's pubkey (the view must not reach into authService). */
  public currentPubkey(): string {
    return this.authService.getCurrentUser()?.pubkey ?? '';
  }

  /**
   * Last fully loaded board state — rendered instantly on re-open while the
   * background refresh reconciles it (stale-while-revalidate).
   */
  public getCachedBoard(): FeedbackBoardState | null {
    return this.cachedState;
  }

  /**
   * Fetch the full public board (board + cards + comments + deletions) and
   * reduce it to state. Archived cards come back with `archived: true` — the
   * renderer decides visibility (dev-only archive section). Every fetch is
   * scoped to our board address, so foreign boards never enter the addon.
   * When `onFirstBatch` is given it is called with the cards-only snapshot
   * right after the first relay batch so the view can paint progressively.
   */
  public async loadBoard(
    onFirstBatch?: (state: FeedbackBoardState) => void
  ): Promise<FeedbackBoardState> {
    const relays = this.relayConfig.getReadRelays();

    // Batch 1: board definition + all cards of our board.
    const first = await this.transport.fetchDirect(
      relays,
      [
        {
          kinds: [FEEDBACK_BOARD_KIND] as unknown as NDKKind[],
          authors: [FEEDBACK_DEV_PUBKEY],
          limit: 5,
        },
        {
          kinds: [FEEDBACK_CARD_KIND] as unknown as NDKKind[],
          '#a': [boardAddress()],
          limit: 500,
        },
      ],
      10000,
      'feedback-board',
      // Wait for every relay to EOSE — a first-relay return regularly missed
      // archive/status events stored on slower relays, which made the board
      // state flicker between refreshes.
      true
    );

    const boardEvent = first.find(e => e.kind === FEEDBACK_BOARD_KIND);
    // Dev's client provisions the board event when it is missing (detached) —
    // cards work either way; the 30301 event makes the board discoverable
    // for kanbanstr and compatible clients.
    if (!boardEvent) this.ensureBoard();
    const cardEvents = first.filter(e => e.kind === FEEDBACK_CARD_KIND);
    const { tickets, cardEvents: versionsByD } = foldCards(cardEvents);

    // Progressive hydration: once the cards are in, the board is usable —
    // comments and deletion reconciliation continue in the background. The
    // caller renders this snapshot immediately; overlays are applied so
    // optimistic actions never flicker (the consumption branches are
    // skipped — the final pass below settles them against the full state).
    if (onFirstBatch) {
      const partialComments = new Map<string, FeedbackComment[]>();
      this.applyOverlays(tickets, partialComments, false);
      onFirstBatch({
        tickets: this.sortedTickets(tickets),
        comments: partialComments,
      });
    }

    // Batch 2: NIP-22 comments matched via coordinates and event ids (a card
    // can be known under its author's coordinate AND the dev's republish).
    const coords = cardCoordinates(versionsByD);
    const cardIds = [...versionsByD.values()]
      .flat()
      .map(e => e.id)
      .filter((id): id is string => !!id);
    const commentFilters: NDKFilter[] = [];
    if (coords.length) {
      commentFilters.push({
        kinds: [FEEDBACK_COMMENT_KIND] as unknown as NDKKind[],
        '#A': coords,
        limit: 500,
      });
    }
    if (cardIds.length) {
      commentFilters.push({
        kinds: [FEEDBACK_COMMENT_KIND] as unknown as NDKKind[],
        '#e': cardIds,
        limit: 500,
      });
    }
    let commentEvents: NostrEvent[] = [];
    if (commentFilters.length) {
      commentEvents = await this.transport.fetchDirect(
        relays,
        commentFilters,
        10000,
        'feedback-board-comments',
        true
      );
    }
    const comments = buildComments(commentEvents, versionsByD);

    // Batch 3: NIP-09 deletion requests referencing our cards or comments.
    // Our deletes always tag `e` (target event id), so `#e` is a precise,
    // small filter.
    const ticketIds = [...tickets.values()]
      .flatMap(t => [t.eventId, t.devEventId])
      .filter((id): id is string => !!id);
    const commentIds = [...comments.values()]
      .flat()
      .map(c => c.eventId)
      .filter(Boolean);
    let deletions: NostrEvent[] = [];
    if (ticketIds.length || commentIds.length) {
      deletions = await this.transport.fetchDirect(
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
    }
    applyDeletions(deletions, tickets, versionsByD, comments);

    this.applyOverlays(tickets, comments, true);

    const state = { tickets: this.sortedTickets(tickets), comments };
    this.cachedState = state;
    return state;
  }

  /** Tickets sorted newest first (the state shape the view renders). */
  private sortedTickets(
    tickets: Map<string, FeedbackTicket>
  ): FeedbackTicket[] {
    return [...tickets.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Apply the local overlays on top of a relay state snapshot. Called twice
   * per board load: once for the progressive first-batch render (`final`
   * false — consumption branches are skipped so the overlay is settled only
   * against the complete relay state) and once for the final pass (`final`
   * true — entries the relay state has caught up with are dropped).
   */
  private applyOverlays(
    tickets: Map<string, FeedbackTicket>,
    comments: Map<string, FeedbackComment[]>,
    final: boolean
  ): void {
    for (const ticket of tickets.values()) {
      // Apply the local overlay; drop entries the relay state has caught up
      // with.
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
        if (final && stillPending.length === 0) {
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

    if (final) {
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
    }

    // Optimistically hidden via local overlay (relays may ignore NIP-09).
    for (const dTag of this.pendingDeleted) {
      tickets.delete(dTag);
    }

    // Optimistically created cards — shown until the relay state catches up,
    // then the overlay entry is dropped.
    for (const [dTag, pendingTicket] of this.pendingTickets) {
      if (tickets.has(dTag)) {
        this.pendingTickets.delete(dTag);
      } else {
        tickets.set(dTag, pendingTicket);
      }
    }
  }

  /**
   * The dev's client provisions the board event on first visit. Detached —
   * the board works without it (cards reference the well-known address);
   * the 30301 event makes the board discoverable for kanbanstr and friends.
   */
  public ensureBoard(): void {
    if (!this.isDev()) return;
    void (async () => {
      const event = await this.publish(FEEDBACK_BOARD_KIND, '', [
        ['d', FEEDBACK_BOARD_DTAG],
        ['title', 'NoorNote Feedback'],
        [
          'description',
          'Public feedback board for the NoorNote Nostr client — file wishes and bugs, follow their progress.',
        ],
        ['alt', 'A public feedback board for the NoorNote Nostr client'],
        ['col', 'todo', 'To Do', '0'],
        ['col', 'in-progress', 'In Progress', '1'],
        ['col', 'done', 'Done', '2'],
      ]);
      if (event) {
        diagLog('system', 'Feedback board definition published', {
          kind: FEEDBACK_BOARD_KIND,
        });
      }
    })();
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
      status: 'todo',
      archived: false,
      type,
    };
    this.pendingTickets.set(dTag, localTicket);

    void (async () => {
      const event = await this.publishCard(
        dTag,
        localTicket.title,
        localTicket.description,
        localTicket.type,
        statusToS('todo'),
        false
      );
      if (event) {
        localTicket.eventId = event.id ?? '';
        diagLog('system', 'Feedback ticket created', { dTag, type });
        await this.notifyOtherSide(
          localTicket,
          _('New feedback board ticket: "%s"').replace('%s', localTicket.title)
        );
      } else {
        this.pendingTickets.delete(dTag);
        onRollback();
      }
    })();

    return localTicket;
  }

  /**
   * Move a card (dev: any status) or withdraw it (author: own card, status
   * withdrawn) — optimistic. The move is a full card republish with the same
   * `d` and a new `s` tag; title/description/type are carried forward so the
   * fold keeps the author's content.
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
      const ok = await this.republish(ticket, { status });
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
   * Archive a ticket (dev only) — optimistic, like setStatus. The republish
   * carries the `archived` tag and the current `s` value forward.
   */
  public archiveTicket(
    ticket: FeedbackTicket,
    onRollback: () => void
  ): boolean {
    if (!this.isDev()) return false;

    this.pendingArchived.add(ticket.dTag);

    void (async () => {
      const ok = await this.republish(ticket, { archived: true });
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
   * Delete a ticket via NIP-09 (kind 5) — optimistic. The author may delete
   * their own ticket, the dev may delete any ticket. The delete event tags
   * `a` (the card coordinate) + `e` for the author's and the dev's versions
   * AND one `e` per comment, so relays honoring NIP-09 also drop the comment
   * thread — no orphaned comments left behind.
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
        ['a', cardAddress(ticket.authorPubkey, ticket.dTag)],
        ['e', ticket.eventId],
        ...(ticket.devEventId ? [['e', ticket.devEventId]] : []),
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
   * comment event id), so the original card stays untouched.
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
      const event = await this.publishComment(ticket, text);
      if (event) {
        entry.eventId = this.lastPublishedCommentId;
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

  public statusLabel(status: FeedbackTicketStatus): string {
    switch (status) {
      case 'todo':
        return _('To Do');
      case 'in-progress':
        return _('In Progress');
      case 'done':
        return _('Done');
      case 'withdrawn':
        return _('Withdrawn');
    }
  }

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
    // Chronological ascending (oldest top, newest bottom — like kind:1 note
    // threads). Re-sort the merge: a laggy relay can return someone else's
    // newer comment between two optimistic entries.
    return [...relay, ...pending.filter(c => !relayIds.has(c.eventId))].sort(
      (a, b) => a.createdAt - b.createdAt
    );
  }

  /**
   * The other side of the actor: dev acts → author gets the DM,
   * anyone else acts → dev gets the DM. Routed through the dms module API
   * (addons never import decoupled services directly).
   */
  private async notifyOtherSide(
    ticket: FeedbackTicket,
    reason: string
  ): Promise<void> {
    const current = this.authService.getCurrentUser();
    if (!current) return;

    const recipient = isDevPubkey(current.pubkey)
      ? ticket.authorPubkey
      : FEEDBACK_DEV_PUBKEY;
    // Acting on a ticket the dev authored would DM the dev about their own
    // action — skip it.
    if (recipient === current.pubkey) return;
    await this.sendDM(
      recipient,
      `${reason}, ${_('Only readable in NoorNote.')}`
    );
  }

  /**
   * NIP-17 DM via the dms module API. Arrival already triggers the standard
   * in-app notification (toast + sidebar badge) on the recipient — the DM is
   * both the notification and the pointer to the board.
   */
  private async sendDM(
    recipientPubkey: string,
    content: string
  ): Promise<void> {
    try {
      const dms = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
      const ok = (await dms?.sendMessage(recipientPubkey, content)) ?? false;
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

  /**
   * Publish a fresh card (create). Tags per NIP-100: `d`, `title`,
   * `description`, `alt`, `s` (column name), `a` (board address), `t` (type).
   * Content carries `<title>\n\n<description>` as fallback for clients that
   * don't read the tags.
   */
  private async publishCard(
    dTag: string,
    title: string,
    description: string,
    type: FeedbackTicketType | undefined,
    status: string,
    archived: boolean
  ): Promise<NostrEvent | null> {
    const tags: string[][] = [
      ['d', dTag],
      ['title', title],
      ['description', description],
      ['alt', 'A feedback ticket on the NoorNote feedback board'],
      ['s', status],
      ['a', boardAddress()],
      // NIP-100 assignee: the dev handles every ticket on this board. Always
      // emitted fresh (constant value) — republishes need no carry-forward.
      ['p', FEEDBACK_DEV_PUBKEY],
    ];
    if (type) tags.push(['t', type]);
    if (archived) tags.push(['archived', '1']);
    return this.publish(FEEDBACK_CARD_KIND, `${title}\n\n${description}`, tags);
  }

  /**
   * Republish an existing card with the same `d` (NIP-100 edit semantics).
   * Everything not overridden is carried forward from the folded state so a
   * move never wipes the author's text and an edit never resets the status.
   */
  private async republish(
    ticket: FeedbackTicket,
    overrides: { status?: FeedbackTicketStatus; archived?: boolean }
  ): Promise<boolean> {
    const event = await this.publishCard(
      ticket.dTag,
      ticket.title,
      ticket.description,
      ticket.type,
      statusToS(overrides.status ?? ticket.status),
      overrides.archived ?? ticket.archived
    );
    return !!event;
  }

  /**
   * NIP-22 comment on a card: root and parent are the card itself, so both
   * the addressable (`A`/`a`) and the event-id (`E`/`e`) reference forms are
   * included — for every version of the card we know (the author's original
   * coordinate and the dev's republish coordinate), so the comment matches
   * no matter which version a client folded.
   */
  private async publishComment(
    ticket: FeedbackTicket,
    text: string
  ): Promise<NostrEvent | null> {
    const current = this.authService.getCurrentUser();
    if (!current) return null;

    const coords = new Set<string>([
      cardAddress(ticket.authorPubkey, ticket.dTag),
    ]);
    if (ticket.devEventId) {
      coords.add(cardAddress(FEEDBACK_DEV_PUBKEY, ticket.dTag));
    }
    const tags: string[][] = [];
    for (const coord of coords) {
      tags.push(['A', coord]);
      tags.push(['a', coord]);
    }
    tags.push(['K', String(FEEDBACK_CARD_KIND)]);
    tags.push(['k', String(FEEDBACK_CARD_KIND)]);
    // Reference every version of the card we know (author's + dev's).
    for (const id of [ticket.eventId, ticket.devEventId]) {
      if (id) {
        tags.push(['E', id]);
        tags.push(['e', id]);
      }
    }
    if (ticket.authorPubkey) {
      tags.push(['P', ticket.authorPubkey]);
      tags.push(['p', ticket.authorPubkey]);
    }

    const event = await this.publish(FEEDBACK_COMMENT_KIND, text, tags);
    if (event?.id) {
      this.lastPublishedCommentId = event.id;
    }
    return event;
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

  /**
   * Total sats zapped per ticket (zap badge on each card, kanbanstr parity).
   * One batched kind-9735 fetch across all card coordinates; a receipt
   * mirrors the zap request's `a` tag, so sums de-aggregate by splitting it.
   * Best effort: a failed fetch just yields an empty map, the caller renders
   * the badge only for tickets with a total.
   */
  public async fetchZapTotals(
    tickets: FeedbackTicket[]
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    if (!tickets.length) return totals;
    try {
      const events = await this.transport.fetchDirect(
        this.relayConfig.getReadRelays(),
        [
          {
            kinds: [9735] as unknown as NDKKind[],
            '#a': tickets.map(t => cardAddress(t.authorPubkey, t.dTag)),
            limit: 500,
          },
        ],
        5000,
        'feedback-board-zap-totals'
      );
      const seen = new Set<string>();
      for (const event of events) {
        if (!event.id || seen.has(event.id)) continue;
        seen.add(event.id);
        const dTag = event.tags.find(t => t[0] === 'a')?.[1]?.split(':')[2];
        if (!dTag) continue;
        totals.set(dTag, (totals.get(dTag) ?? 0) + getZapAmountSats(event));
      }
    } catch (error) {
      this.systemLogger.warn(
        'FeedbackBoard',
        `Zap totals fetch failed: ${errMessage(error)}`
      );
    }
    return totals;
  }
}
