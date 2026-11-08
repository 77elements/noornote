import { describe, it, expect, vi } from 'vitest';

// quotedReposts.ts imports FetchNostrEvents at module level, which drags in
// the lists/ stack (PlatformService at import time) — cut that chain off.
vi.mock('../services/FetchNostrEvents', () => ({
  fetchNostrEvents: vi.fn(async () => ({ events: [] })),
}));

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ThreadNode } from './threadTree';
import {
  mergeChronologicalComments,
  pinAuthorReplies,
  isAuthorTopLevelReply,
} from './quotedReposts';

const AUTHOR = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function ev(id: string, pubkey: string, ts: number): NostrEvent {
  return { id, pubkey, created_at: ts } as unknown as NostrEvent;
}

function node(id: string, pubkey: string, ts: number, depth = 0): ThreadNode {
  return { event: ev(id, pubkey, ts), children: [], depth };
}

describe('mergeChronologicalComments', () => {
  it('sorts replies and quotes oldest first', () => {
    const merged = mergeChronologicalComments(
      [node('r2', OTHER, 300), node('r1', OTHER, 100)],
      [ev('q1', OTHER, 200)]
    );
    expect(
      merged.map(c => (c.type === 'reply' ? c.node.event.id : c.event.id))
    ).toEqual(['r1', 'q1', 'r2']);
  });
});

describe('pinAuthorReplies', () => {
  it('pins the author’s top-level replies to the top, chronological among themselves', () => {
    const comments = mergeChronologicalComments(
      [
        node('other1', OTHER, 100),
        node('mine1', AUTHOR, 200),
        node('other2', OTHER, 300),
        node('mine2', AUTHOR, 400),
      ],
      []
    );
    const pinned = pinAuthorReplies(comments, AUTHOR);
    expect(
      pinned.map(c => (c.type === 'reply' ? c.node.event.id : c.event.id))
    ).toEqual(['mine1', 'mine2', 'other1', 'other2']);
  });

  it('pins only DIRECT replies, not nested ones', () => {
    const comments = mergeChronologicalComments(
      [
        node('other1', OTHER, 100),
        node('mine-nested', AUTHOR, 200, 1),
        node('other2', OTHER, 300),
      ],
      []
    );
    const pinned = pinAuthorReplies(comments, AUTHOR);
    expect(
      pinned.map(c => (c.type === 'reply' ? c.node.event.id : c.event.id))
    ).toEqual(['other1', 'mine-nested', 'other2']);
  });

  it('keeps everything chronological when the author has not replied', () => {
    const comments = mergeChronologicalComments(
      [node('o1', OTHER, 100), node('o2', OTHER, 200)],
      [ev('q1', OTHER, 150)]
    );
    const pinned = pinAuthorReplies(comments, AUTHOR);
    expect(pinned).toEqual(comments);
  });

  it('never pins other users’ replies even when they reply early', () => {
    const comments = mergeChronologicalComments(
      [node('other-early', OTHER, 50), node('mine-late', AUTHOR, 900)],
      []
    );
    const pinned = pinAuthorReplies(comments, AUTHOR);
    expect(
      pinned.map(c => (c.type === 'reply' ? c.node.event.id : c.event.id))
    ).toEqual(['mine-late', 'other-early']);
  });

  it('does not mutate the input array', () => {
    const comments = mergeChronologicalComments(
      [node('o1', OTHER, 100), node('m1', AUTHOR, 200)],
      []
    );
    const snapshot = [...comments];
    pinAuthorReplies(comments, AUTHOR);
    expect(comments).toEqual(snapshot);
  });

  it('isAuthorTopLevelReply requires depth 0 and matching pubkey', () => {
    const top = {
      type: 'reply' as const,
      node: node('x', AUTHOR, 1, 0),
      timestamp: 1,
    };
    const nested = {
      type: 'reply' as const,
      node: node('y', AUTHOR, 1, 2),
      timestamp: 1,
    };
    const foreign = {
      type: 'reply' as const,
      node: node('z', OTHER, 1, 0),
      timestamp: 1,
    };
    expect(isAuthorTopLevelReply(top, AUTHOR)).toBe(true);
    expect(isAuthorTopLevelReply(nested, AUTHOR)).toBe(false);
    expect(isAuthorTopLevelReply(foreign, AUTHOR)).toBe(false);
    expect(isAuthorTopLevelReply(top, undefined)).toBe(false);
  });
});
