/**
 * Pure reducer tests for the feedback board (NIP-100 card model).
 *
 * The vanish-comments regression: the legacy 39101 action model published
 * WITHOUT a d tag, so every new action by the same author replaced all their
 * previous ones on the relay (parameterized replaceable, empty d). Comments
 * are now append-only kind-1111 events — test that multiple comments by the
 * same author all survive the fold.
 */

import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  FEEDBACK_DEV_PUBKEY,
  cardAddress,
  statusToS,
} from './feedbackBoardConstants';
import {
  applyDeletions,
  buildComments,
  foldCards,
} from './feedbackBoardReducer';

const AUTHOR =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROGUE =
  'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const D = 'noornote-feedback-1700000000000';
const BOARD = cardAddress(FEEDBACK_DEV_PUBKEY, 'noornote-feedback');

function makeEvent(
  kind: number,
  pubkey: string,
  createdAt: number,
  tags: string[][],
  content = '',
  id = 'unused-id'
): NostrEvent {
  return {
    id,
    kind,
    pubkey,
    created_at: createdAt,
    tags,
    content,
    sig: 'fake',
  } as unknown as NostrEvent;
}

function card(
  pubkey: string,
  createdAt: number,
  id: string,
  overrides: Record<string, string> = {},
  content = 'My title\n\nMy description'
): NostrEvent {
  // Base tags merged with overrides (a republish REPLACES tag values —
  // duplicate tags would break firstTag lookups).
  const merged: Record<string, string> = {
    d: D,
    title: 'My title',
    description: 'My description',
    s: statusToS('todo'),
    a: BOARD,
    ...overrides,
  };
  const tags = Object.entries(merged).map(([k, v]) => [k, v]);
  return makeEvent(30302, pubkey, createdAt, tags, content, id);
}

describe('foldCards', () => {
  it('folds a fresh author card into To Do', () => {
    const { tickets } = foldCards([card(AUTHOR, 100, 'card-1')]);
    const ticket = tickets.get(D);
    expect(ticket).toBeDefined();
    expect(ticket?.status).toBe('todo');
    expect(ticket?.title).toBe('My title');
    expect(ticket?.description).toBe('My description');
    expect(ticket?.authorPubkey).toBe(AUTHOR);
    expect(ticket?.archived).toBe(false);
  });

  it('dev republish (same d, new s) moves the card and keeps content', () => {
    const devMove = card(FEEDBACK_DEV_PUBKEY, 200, 'card-2', {
      s: statusToS('in-progress'),
    });
    const { tickets } = foldCards([card(AUTHOR, 100, 'card-1'), devMove]);
    const ticket = tickets.get(D);
    expect(ticket?.status).toBe('in-progress');
    expect(ticket?.title).toBe('My title');
    expect(ticket?.devEventId).toBe('card-2');
    // created_at stays the ORIGINAL creation
    expect(ticket?.createdAt).toBe(100);
  });

  it('author edit after a dev move wins with the carried-forward status', () => {
    const edit = card(
      AUTHOR,
      300,
      'card-3',
      {
        s: statusToS('in-progress'),
        title: 'Edited title',
        description: 'Edited description',
      },
      'Edited title\n\nEdited description'
    );
    const { tickets } = foldCards([
      card(AUTHOR, 100, 'card-1'),
      card(FEEDBACK_DEV_PUBKEY, 200, 'card-2', { s: statusToS('in-progress') }),
      edit,
    ]);
    const ticket = tickets.get(D);
    expect(ticket?.title).toBe('Edited title');
    expect(ticket?.description).toBe('Edited description');
    expect(ticket?.status).toBe('in-progress');
  });

  it('ignores rogue third-party cards with a copied d tag', () => {
    const rogue = card(ROGUE, 400, 'card-4', {
      title: 'Hijacked',
      description: 'spam',
    });
    const { tickets } = foldCards([
      card(AUTHOR, 100, 'card-1'),
      card(FEEDBACK_DEV_PUBKEY, 200, 'card-2'),
      rogue,
    ]);
    const ticket = tickets.get(D);
    expect(ticket?.title).toBe('My title');
  });

  it('ignores cards without the noornote-feedback d prefix', () => {
    const foreign = makeEvent(30302, AUTHOR, 100, [
      ['d', 'some-other-board-card'],
      ['title', 'Foreign'],
      ['s', 'To Do'],
    ]);
    const { tickets } = foldCards([foreign]);
    expect(tickets.size).toBe(0);
  });

  it('keeps archived sticky from the dev republish', () => {
    const { tickets } = foldCards([
      card(AUTHOR, 100, 'card-1', { s: statusToS('done') }),
      card(FEEDBACK_DEV_PUBKEY, 200, 'card-2', {
        s: statusToS('done'),
        archived: '1',
      }),
    ]);
    const ticket = tickets.get(D);
    expect(ticket?.archived).toBe(true);
    expect(ticket?.archivedAt).toBe(200);
  });

  it('parses title/description from content when tags are missing', () => {
    const bare = makeEvent(
      30302,
      AUTHOR,
      100,
      [
        ['d', D],
        ['s', 'Done'],
      ],
      'Only Content Title\n\nOnly content description',
      'card-1'
    );
    const { tickets } = foldCards([bare]);
    expect(tickets.get(D)?.title).toBe('Only Content Title');
    expect(tickets.get(D)?.description).toBe('Only content description');
    expect(tickets.get(D)?.status).toBe('done');
  });
});

describe('buildComments (vanish-comments regression)', () => {
  it('keeps multiple comments by the same author (append-only, no replaceable collision)', () => {
    const cardEvents = new Map([[D, [card(AUTHOR, 100, 'card-1')]]]);
    const c1 = makeEvent(
      1111,
      AUTHOR,
      110,
      [
        ['A', cardAddress(AUTHOR, D)],
        ['a', cardAddress(AUTHOR, D)],
        ['E', 'card-1'],
        ['e', 'card-1'],
        ['K', '30302'],
        ['k', '30302'],
      ],
      'first comment',
      'comment-1'
    );
    const c2 = makeEvent(
      1111,
      AUTHOR,
      130,
      [
        ['A', cardAddress(AUTHOR, D)],
        ['a', cardAddress(AUTHOR, D)],
        ['E', 'card-1'],
        ['e', 'card-1'],
      ],
      'second comment',
      'comment-2'
    );
    const comments = buildComments([c1, c2], cardEvents);
    const list = comments.get(D) ?? [];
    expect(list).toHaveLength(2);
    expect(list.map(c => c.content)).toEqual([
      'first comment',
      'second comment',
    ]);
  });

  it('matches comments via the dev republish coordinate and via event id', () => {
    const devMove = card(FEEDBACK_DEV_PUBKEY, 200, 'card-2', {
      s: statusToS('done'),
    });
    const cardEvents = new Map([[D, [card(AUTHOR, 100, 'card-1'), devMove]]]);
    const byDevCoord = makeEvent(
      1111,
      AUTHOR,
      210,
      [['A', cardAddress(FEEDBACK_DEV_PUBKEY, D)]],
      'via dev coord',
      'comment-1'
    );
    const byAuthorEventId = makeEvent(
      1111,
      AUTHOR,
      220,
      [['e', 'card-1']],
      'via author event id',
      'comment-2'
    );
    const comments = buildComments([byDevCoord, byAuthorEventId], cardEvents);
    expect(comments.get(D)).toHaveLength(2);
  });

  it('drops comments referencing unknown cards', () => {
    const cardEvents = new Map([[D, [card(AUTHOR, 100, 'card-1')]]]);
    const stray = makeEvent(
      1111,
      AUTHOR,
      110,
      [['A', '30302:unknownpubkey:noornote-feedback-999']],
      'stray',
      'comment-1'
    );
    const comments = buildComments([stray], cardEvents);
    expect(comments.size).toBe(0);
  });
});

describe('applyDeletions', () => {
  function boardState() {
    const cardEvents = new Map([[D, [card(AUTHOR, 100, 'card-1')]]]);
    const { tickets } = foldCards([card(AUTHOR, 100, 'card-1')]);
    const comment = makeEvent(
      1111,
      AUTHOR,
      110,
      [['A', cardAddress(AUTHOR, D)]],
      'a comment',
      'comment-1'
    );
    const comments = buildComments([comment], cardEvents);
    return { tickets, cardEvents, comments };
  }

  it('author delete (e ref) removes the ticket and its comments', () => {
    const { tickets, cardEvents, comments } = boardState();
    const deletion = makeEvent(5, AUTHOR, 300, [['e', 'card-1']], '', 'del-1');
    applyDeletions([deletion], tickets, cardEvents, comments);
    expect(tickets.has(D)).toBe(false);
    expect(comments.has(D)).toBe(false);
  });

  it('dev delete via a-coordinate removes any ticket', () => {
    const { tickets, cardEvents, comments } = boardState();
    const deletion = makeEvent(
      5,
      FEEDBACK_DEV_PUBKEY,
      300,
      [['a', cardAddress(AUTHOR, D)]],
      '',
      'del-1'
    );
    applyDeletions([deletion], tickets, cardEvents, comments);
    expect(tickets.has(D)).toBe(false);
  });

  it('a foreign pubkey cannot delete a ticket', () => {
    const { tickets, cardEvents, comments } = boardState();
    const deletion = makeEvent(5, ROGUE, 300, [['e', 'card-1']], '', 'del-1');
    applyDeletions([deletion], tickets, cardEvents, comments);
    expect(tickets.has(D)).toBe(true);
    expect(comments.has(D)).toBe(true);
  });

  it('comment delete works for the writer but not for a foreign pubkey', () => {
    const { tickets, cardEvents, comments } = boardState();
    const foreignDelete = makeEvent(
      5,
      ROGUE,
      300,
      [['e', 'comment-1']],
      '',
      'del-1'
    );
    applyDeletions([foreignDelete], tickets, cardEvents, comments);
    expect(comments.get(D)).toHaveLength(1);

    const writerDelete = makeEvent(
      5,
      AUTHOR,
      310,
      [['e', 'comment-1']],
      '',
      'del-2'
    );
    applyDeletions([writerDelete], tickets, cardEvents, comments);
    expect(comments.has(D)).toBe(false);
    // The ticket itself stays.
    expect(tickets.has(D)).toBe(true);
  });
});
