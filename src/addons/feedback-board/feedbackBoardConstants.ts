import { npubToHex } from '../../helpers/nip19';

/**
 * Feedback Board — kanbanstr-compatible event model (NIP-100 draft,
 * https://github.com/vivganes/kanbanstr/blob/main/NIP-100.md, PR
 * nostr-protocol/nips#1665):
 *
 *   kind 30301 — the board definition, published by the dev account.
 *   kind 30302 — a ticket card, published by its author and referenced to the
 *                board via the `a` tag. Status moves, edits and archiving are
 *                REPUBLISHES of the card with the same `d` (NIP-100 fold:
 *                latest event by the board creator or the original card
 *                author wins). Cards are our namespace marker: only cards
 *                whose `a` tag resolves to our board address are shown.
 *   kind 1111  — NIP-22 comments on a card (append-only — never replaceable,
 *                which is what killed comments in the legacy 39101 model).
 *   kind 5     — NIP-09 deletion (ticket + comment thread / single comment).
 */
export const FEEDBACK_BOARD_KIND = 30301;
export const FEEDBACK_CARD_KIND = 30302;
export const FEEDBACK_COMMENT_KIND = 1111;
/** NIP-09 event deletion — used to remove tickets/comments from relays. */
export const FEEDBACK_DELETE_KIND = 5;

/** The board's `d` identifier and the one dev account that owns it. */
export const FEEDBACK_BOARD_DTAG = 'noornote-feedback';
export const FEEDBACK_DEV_NPUB =
  'npub175nul9cvufswwsnpy99lvyhg7ad9nkccxhkhusznxfkr7e0zxthql9g6w0';
export const FEEDBACK_DEV_PUBKEY = npubToHex(FEEDBACK_DEV_NPUB) ?? '';

export const FEEDBACK_DTAG_PREFIX = 'noornote-feedback-';

/**
 * NIP-100 board address — the value every card carries in its `a` tag and
 * the `#a` filter value our fetches are scoped with.
 */
export function boardAddress(): string {
  return `${FEEDBACK_BOARD_KIND}:${FEEDBACK_DEV_PUBKEY}:${FEEDBACK_BOARD_DTAG}`;
}

/** NIP-100 card coordinate: kind:pubkey:d (author or dev republish). */
export function cardAddress(authorPubkey: string, dTag: string): string {
  return `${FEEDBACK_CARD_KIND}:${authorPubkey}:${dTag}`;
}

export function parseCoordinate(
  address: string
): { kind: number; authorPubkey: string; dTag: string } | null {
  const parts = address.split(':');
  if (parts.length !== 3) return null;
  const kind = parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(kind) || !parts[1] || !parts[2]) return null;
  return { kind, authorPubkey: parts[1]!, dTag: parts[2]! };
}

export type FeedbackTicketStatus =
  | 'todo'
  | 'in-progress'
  | 'done'
  | 'withdrawn';
export type FeedbackTicketType = 'bug' | 'wish' | 'question' | 'refinement';

/** All ticket types with their label msgids — single source for UI + parser. */
export const FEEDBACK_TICKET_TYPES: readonly FeedbackTicketType[] = [
  'wish',
  'question',
  'refinement',
  'bug',
];

/**
 * Column mapping. The `s` tag holds the column NAME (per NIP-100 examples and
 * kanbanstr's resolution), the `col` tags on the board event carry stable ids.
 * ⚠️ Never rename a column: an `s` value that matches no `col` name loses the
 * card in every board client. `Withdrawn` is deliberately NOT a column —
 * foreign clients park it in "unknown", NoorNote renders it dimmed.
 */
export const STATUS_TO_COLUMN: Record<
  Exclude<FeedbackTicketStatus, 'withdrawn'>,
  string
> = {
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done',
};
export const WITHDRAWN_COLUMN = 'Withdrawn';

/** Column display order — withdrawn is not a column, it dims in place. */
export const FEEDBACK_COLUMNS: FeedbackTicketStatus[] = [
  'todo',
  'in-progress',
  'done',
];

/** `s` tag value for a status (protocol constant, never translated). */
export function statusToS(status: FeedbackTicketStatus): string {
  return status === 'withdrawn' ? WITHDRAWN_COLUMN : STATUS_TO_COLUMN[status];
}

/** Status from an `s` tag value; unknown/missing values default to To Do. */
export function sToStatus(s: string | undefined): FeedbackTicketStatus {
  const entry = Object.entries(STATUS_TO_COLUMN).find(([, name]) => name === s);
  if (entry) return entry[0] as FeedbackTicketStatus;
  if (s === WITHDRAWN_COLUMN) return 'withdrawn';
  return 'todo';
}

export interface FeedbackTicket {
  /** Ticket id from the `d` tag (full d-tag value). */
  dTag: string;
  /** Event id of the newest card event by the ORIGINAL author. */
  eventId: string;
  /** Event id of the newest republish by the dev, if the dev touched it. */
  devEventId?: string;
  /** Original author (pubkey of the oldest event for this d). */
  authorPubkey: string;
  title: string;
  description: string;
  type?: FeedbackTicketType;
  /** created_at of the original card event. */
  createdAt: number;
  status: FeedbackTicketStatus;
  archived: boolean;
  /** created_at of the event carrying the `archived` tag (dev-side). */
  archivedAt?: number;
}
