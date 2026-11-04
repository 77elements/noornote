/**
 * Pure board-state reducer for the Feedback Board (NIP-100 card model).
 *
 * No singletons, no I/O — everything here is directly unit-testable. The
 * service fetches raw events and hands them over; these functions produce the
 * folded board state.
 *
 * Fold rule (NIP-100 with carry-forward publishing):
 *   - Card identity = the `d` tag. Every 30302 event with the same `d` is a
 *     version of the same card (the author edits, the dev moves/archives).
 *   - "Original author" = pubkey of the OLDEST event for that `d`.
 *   - Eligible events = by the original author or the board creator (dev).
 *     Rogue cards from third parties with a copied `d` are ignored.
 *   - The latest eligible event wins for ALL fields — safe because every
 *     publisher carries the current values forward (author edits carry `s`,
 *     dev moves carry title/description).
 *   - Comments are kind-1111 (NIP-22) events: append-only, matched to cards
 *     via their `A`/`a` coordinates or `E`/`e` event-id refs.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  FEEDBACK_CARD_KIND,
  FEEDBACK_DEV_PUBKEY,
  FEEDBACK_DTAG_PREFIX,
  cardAddress,
  sToStatus,
  type FeedbackTicket,
  type FeedbackTicketType,
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

/** Tag value or undefined (empty string counts as missing). */
export function firstTag(event: NostrEvent, name: string): string | undefined {
  const value = event.tags.find(t => t[0] === name)?.[1];
  return value === '' || value === undefined ? undefined : value;
}

/** All non-empty values of a tag name (for `A`/`a`/`E`/`e` reference lists). */
function allTags(event: NostrEvent, name: string): string[] {
  return event.tags.filter(t => t[0] === name && t[1]).map(t => t[1] as string);
}

export interface FoldResult {
  tickets: Map<string, FeedbackTicket>;
  /**
   * Raw card events per `d` — needed to derive every coordinate the card
   * ever had (author's and dev's republishes) for comment matching.
   */
  cardEvents: Map<string, NostrEvent[]>;
}

/** Split `<title>\n\n<description>` content (fallback when tags are missing). */
function splitContent(content: string): { title: string; description: string } {
  const newlineIndex = content.indexOf('\n');
  const title = (
    newlineIndex === -1 ? content : content.slice(0, newlineIndex)
  ).trim();
  const description =
    newlineIndex === -1 ? '' : content.slice(newlineIndex + 1).trim();
  return { title, description };
}

function parseType(value: string | undefined): FeedbackTicketType | undefined {
  return value === 'bug' ||
    value === 'wish' ||
    value === 'question' ||
    value === 'refinement'
    ? value
    : undefined;
}

/** Fold all kind-30302 card events into the visible ticket list. */
export function foldCards(events: NostrEvent[]): FoldResult {
  const cardEvents = new Map<string, NostrEvent[]>();
  for (const event of events) {
    if (event.kind !== FEEDBACK_CARD_KIND) continue;
    const dTag = firstTag(event, 'd');
    if (!dTag || !dTag.startsWith(FEEDBACK_DTAG_PREFIX)) continue;
    const list = cardEvents.get(dTag) ?? [];
    list.push(event);
    cardEvents.set(dTag, list);
  }

  const tickets = new Map<string, FeedbackTicket>();
  for (const [dTag, versions] of cardEvents) {
    // Oldest first — the first event defines the original author.
    const sorted = [...versions].sort((a, b) => a.created_at - b.created_at);
    const originalAuthor = sorted[0]!.pubkey;
    const eligible = sorted.filter(
      e => e.pubkey === originalAuthor || e.pubkey === FEEDBACK_DEV_PUBKEY
    );
    if (!eligible.length) continue; // rogue-only squatting: ignored

    const original = eligible[0]!;
    const winner = eligible[eligible.length - 1]!;
    const fallback = splitContent(winner.content ?? '');
    const title = firstTag(winner, 'title') ?? fallback.title;
    const description = firstTag(winner, 'description') ?? fallback.description;
    const type = parseType(firstTag(winner, 't') ?? firstTag(original, 't'));

    // Archived stays sticky: it is carried forward by every republish, but
    // an older archived=1 must not be lost if a newer event omits it.
    const archivedEvent = [...eligible]
      .reverse()
      .find(e => firstTag(e, 'archived') === '1');

    const devLatest = [...eligible]
      .reverse()
      .find(e => e.pubkey === FEEDBACK_DEV_PUBKEY);

    const ticket: FeedbackTicket = {
      dTag,
      eventId: eligible[0]!.id ?? '',
      ...(devLatest?.id ? { devEventId: devLatest.id } : {}),
      authorPubkey: original.pubkey,
      title,
      description,
      ...(type ? { type } : {}),
      createdAt: original.created_at,
      status: sToStatus(firstTag(winner, 's')),
      archived: !!archivedEvent,
      ...(archivedEvent ? { archivedAt: archivedEvent.created_at } : {}),
    };
    if (title) tickets.set(dTag, ticket);
  }

  return { tickets, cardEvents };
}

/** Every coordinate a card version ever carried (author + dev republishes). */
export function cardCoordinates(
  cardEvents: Map<string, NostrEvent[]>
): string[] {
  const coords = new Set<string>();
  for (const [dTag, versions] of cardEvents) {
    for (const event of versions) {
      coords.add(cardAddress(event.pubkey, dTag));
    }
  }
  return [...coords];
}

/** All event ids a card is known by (author's + dev's versions). */
function cardEventIds(versions: NostrEvent[]): string[] {
  return versions.map(e => e.id).filter((id): id is string => !!id);
}

/**
 * Match kind-1111 comment events to cards. A comment belongs to a card when
 * one of its `A`/`a` coordinates equals a card coordinate, or one of its
 * `E`/`e` ids equals one of the card's event ids. Comments referencing
 * unknown/deleted cards are dropped.
 */
export function buildComments(
  commentEvents: NostrEvent[],
  cardEvents: Map<string, NostrEvent[]>
): Map<string, FeedbackComment[]> {
  const comments = new Map<string, FeedbackComment[]>();

  for (const event of commentEvents) {
    if (event.kind !== 1111) continue;
    const refs = new Set<string>([
      ...allTags(event, 'A'),
      ...allTags(event, 'a'),
      ...allTags(event, 'E'),
      ...allTags(event, 'e'),
    ]);
    if (!refs.size) continue;

    for (const [dTag, versions] of cardEvents) {
      const coords = versions.map(e => cardAddress(e.pubkey, dTag));
      const ids = cardEventIds(versions);
      const matched =
        coords.some(c => refs.has(c)) || ids.some(id => refs.has(id));
      if (!matched) continue;

      const list = comments.get(dTag) ?? [];
      list.push({
        eventId: event.id ?? '',
        pubkey: event.pubkey,
        content: event.content ?? '',
        createdAt: event.created_at,
      });
      comments.set(dTag, list);
      break;
    }
  }

  for (const list of comments.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }
  return comments;
}

/**
 * Apply NIP-09 deletion events. A ticket is deletable by its original author
 * or the dev (a delete may reference the author's or the dev's event id, or
 * the card coordinate). A comment is deletable by its writer or the dev.
 */
export function applyDeletions(
  deletions: NostrEvent[],
  tickets: Map<string, FeedbackTicket>,
  cardEvents: Map<string, NostrEvent[]>,
  comments: Map<string, FeedbackComment[]>
): void {
  for (const deletion of deletions) {
    const refs = new Set<string>([
      ...allTags(deletion, 'e'),
      ...allTags(deletion, 'a'),
    ]);
    if (!refs.size) continue;

    // Tickets: matched by event id (author's or dev's version) or coordinate.
    for (const [dTag, ticket] of [...tickets.entries()]) {
      const versions = cardEvents.get(dTag) ?? [];
      const targets = new Set<string>([
        ...cardEventIds(versions),
        ...versions.map(e => cardAddress(e.pubkey, dTag)),
      ]);
      const hit = [...targets].some(id => refs.has(id));
      if (!hit) continue;
      if (
        deletion.pubkey === ticket.authorPubkey ||
        deletion.pubkey === FEEDBACK_DEV_PUBKEY
      ) {
        tickets.delete(dTag);
        comments.delete(dTag);
      }
    }

    // Comments: matched by comment event id.
    for (const [dTag, list] of [...comments.entries()]) {
      for (const comment of [...list]) {
        if (!comment.eventId || !refs.has(comment.eventId)) continue;
        if (
          deletion.pubkey === comment.pubkey ||
          deletion.pubkey === FEEDBACK_DEV_PUBKEY
        ) {
          const index = list.indexOf(comment);
          if (index !== -1) list.splice(index, 1);
        }
      }
      if (!list.length) comments.delete(dTag);
    }
  }
}
