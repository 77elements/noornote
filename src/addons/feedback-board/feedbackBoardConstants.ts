import { npubToHex } from '../../helpers/nip19';

/**
 * Public, addressable custom kinds for the Feedback Board (NoorNote-internal).
 * Kind 39100 — a ticket, published by its author (d-tag carries the ticket id).
 * Kind 39101 — an action on a ticket (comment / status change / archive),
 *              published by whoever acts. Board state = latest 39100 per d-tag
 *              plus the valid 39101 actions referencing it.
 */
export const FEEDBACK_TICKET_KIND = 39100;
export const FEEDBACK_ACTION_KIND = 39101;
/** NIP-09 event deletion — used to remove tickets from relays entirely. */
export const FEEDBACK_DELETE_KIND = 5;

export const FEEDBACK_DTAG_PREFIX = 'noornote-feedback-';

/** The one developer account allowed to move and archive tickets. */
export const FEEDBACK_DEV_NPUB =
  'npub175nul9cvufswwsnpy99lvyhg7ad9nkccxhkhusznxfkr7e0zxthql9g6w0';
export const FEEDBACK_DEV_PUBKEY = npubToHex(FEEDBACK_DEV_NPUB) ?? '';

export type FeedbackTicketStatus = 'backlog' | 'wip' | 'done' | 'withdrawn';
export type FeedbackTicketType = 'bug' | 'wish' | 'question' | 'refinement';

/** All ticket types with their label msgids — single source for UI + parser. */
export const FEEDBACK_TICKET_TYPES: readonly FeedbackTicketType[] = [
  'wish',
  'question',
  'refinement',
  'bug',
];
export type FeedbackActionType = 'comment' | 'status' | 'archive';

export const FEEDBACK_STATUSES: FeedbackTicketStatus[] = [
  'backlog',
  'wip',
  'done',
  'withdrawn',
];

/** Column display order — withdrawn is not a column, it dims in place. */
export const FEEDBACK_COLUMNS: FeedbackTicketStatus[] = [
  'backlog',
  'wip',
  'done',
];

export interface FeedbackTicket {
  /** Ticket id from the d-tag (without the noornote-feedback- prefix logic — full d-tag value). */
  dTag: string;
  /** Event id of the newest kind-39100 event for this ticket. */
  eventId: string;
  authorPubkey: string;
  title: string;
  description: string;
  type?: FeedbackTicketType;
  createdAt: number;
  status: FeedbackTicketStatus;
  archived: boolean;
  /** created_at of the archive action (dev-side information). */
  archivedAt?: number;
}

/** a-tag reference format for parameterized replaceable events. */
export function ticketAddress(authorPubkey: string, dTag: string): string {
  return `${FEEDBACK_TICKET_KIND}:${authorPubkey}:${dTag}`;
}

export function parseTicketAddress(
  address: string
): { authorPubkey: string; dTag: string } | null {
  const parts = address.split(':');
  if (parts.length !== 3 || parts[0] !== String(FEEDBACK_TICKET_KIND)) {
    return null;
  }
  return { authorPubkey: parts[1] ?? '', dTag: parts[2] ?? '' };
}
