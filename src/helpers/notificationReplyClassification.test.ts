/**
 * Tests for notificationReplyClassification — the reply vs thread-reply
 * decision that drives the notification diode priority.
 *
 * Regression context: classification used to depend solely on USER_EVENT_IDS
 * (last 50 own events at login), so every reply to an older note was
 * misclassified as 'thread-reply' (low priority diode).
 */

import { describe, expect, it } from 'vitest';

import {
  isDirectCommentToOwnContent,
  isDirectReplyToOwnNote,
} from './notificationReplyClassification';

const ME = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const THIRD = 'c'.repeat(64);

// Stable synthetic event IDs
const MY_ROOT = 'e'.repeat(64);
const MY_OLD_NOTE = '1'.repeat(64);
const OTHER_NOTE = '2'.repeat(64);
const OTHER_REPLY = '3'.repeat(64);

describe('isDirectReplyToOwnNote (NIP-10, kind 1/20)', () => {
  it('classifies a marked reply to my old note (outside the 50-event window) as direct reply', () => {
    // Thread: my note is root AND direct parent, reply carries both markers.
    // My note ID is NOT in the fetch window; p-tag parallel-index maps parent
    // author to me.
    const tags = [
      ['e', MY_OLD_NOTE, '', 'root'],
      ['e', MY_OLD_NOTE, '', 'reply'],
      ['p', ME],
    ];
    expect(
      isDirectReplyToOwnNote({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(true);
  });

  it('classifies a marked reply in my thread whose parent is someone else as thread reply', () => {
    // e: [root=mine, reply=other's reply], p: [me(root author), other(parent author)]
    const tags = [
      ['e', MY_ROOT, '', 'root'],
      ['e', OTHER_REPLY, '', 'reply'],
      ['p', ME],
      ['p', OTHER],
    ];
    expect(
      isDirectReplyToOwnNote({ tags, userPubkey: ME, userEventIds: [MY_ROOT] })
    ).toBe(false);
  });

  it('classifies an unmarked single-e-tag reply to my old note as direct reply', () => {
    // Deprecated positional style: one e-tag = parent, one p-tag = parent author.
    const tags = [
      ['e', MY_OLD_NOTE],
      ['p', ME],
    ];
    expect(
      isDirectReplyToOwnNote({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(true);
  });

  it('classifies an unmarked reply to an unknown note as thread reply', () => {
    const tags = [
      ['e', OTHER_NOTE],
      ['p', OTHER],
    ];
    expect(
      isDirectReplyToOwnNote({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(false);
  });

  it('resolves the parent author via the cache when tags are ambiguous', () => {
    // Reply marker points to a parent neither in window nor identifiable by
    // p-tag index (mention appended after), but NoteService has the parent.
    const tags = [
      ['e', MY_OLD_NOTE, '', 'root'],
      ['e', MY_OLD_NOTE, '', 'reply'],
      ['p', ME],
      ['p', THIRD], // extra mention p-tag appended after the structural ones
    ];
    const ctx = {
      tags,
      userPubkey: ME,
      userEventIds: [],
      resolveParentAuthor: (id: string) => (id === MY_OLD_NOTE ? ME : null),
    };
    expect(isDirectReplyToOwnNote(ctx)).toBe(true);
  });

  it('rejects a reply whose cached parent author is someone else', () => {
    const tags = [
      ['e', OTHER_NOTE, '', 'reply'],
      ['p', ME], // mentioned, parent is not mine
    ];
    const ctx = {
      tags,
      userPubkey: ME,
      userEventIds: [],
      resolveParentAuthor: (id: string) => (id === OTHER_NOTE ? OTHER : null),
    };
    expect(isDirectReplyToOwnNote(ctx)).toBe(false);
  });

  it('does not let an appended mention p-tag turn a reply to someone else into a direct reply', () => {
    // Reply to OTHER's note (uncached), content mentions me → mention p-tag
    // appended after the structural p-tags. Parallel-index must pick OTHER.
    const tags = [
      ['e', MY_ROOT, '', 'root'],
      ['e', OTHER_REPLY, '', 'reply'],
      ['p', ME], // root author
      ['p', OTHER], // parent author
      ['p', ME], // mention in reply text
    ];
    expect(
      isDirectReplyToOwnNote({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(false);
  });

  it('returns false for a bare p-tag mention without any e-tag (not a reply)', () => {
    const tags = [['p', ME]];
    expect(
      isDirectReplyToOwnNote({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(false);
  });

  it('classifies a window-hit reply as direct reply regardless of tags', () => {
    const tags = [
      ['e', MY_ROOT, '', 'reply'],
      ['p', ME],
    ];
    expect(
      isDirectReplyToOwnNote({
        tags,
        userPubkey: ME,
        userEventIds: [MY_ROOT],
      })
    ).toBe(true);
  });
});

describe('isDirectCommentToOwnContent (NIP-22, kind 1111)', () => {
  it('classifies an article comment on my content (addressable parent, no e-tag) as direct reply', () => {
    // NIP-22 comment on a kind 30023 article: lowercase p = parent author = me.
    const tags = [
      ['A', `30023:${ME}:my-article`],
      ['p', ME],
      ['K', '30023'],
      ['k', '30023'],
    ];
    expect(
      isDirectCommentToOwnContent({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(true);
  });

  it('classifies a comment whose parent is my old note (outside window) as direct reply', () => {
    const tags = [
      ['E', MY_ROOT, '', 'root'],
      ['e', MY_OLD_NOTE, '', 'reply'],
      ['P', ME],
      ['p', ME],
    ];
    expect(
      isDirectCommentToOwnContent({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(true);
  });

  it('classifies a 2nd-level comment in my thread as thread reply', () => {
    // Parent = someone else's comment, root = mine.
    const tags = [
      ['E', MY_ROOT],
      ['e', OTHER_REPLY],
      ['P', ME],
      ['p', OTHER],
    ];
    expect(
      isDirectCommentToOwnContent({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(false);
  });

  it('classifies a comment whose parent is in the window as direct reply', () => {
    const tags = [
      ['e', MY_ROOT],
      ['p', ME],
    ];
    expect(
      isDirectCommentToOwnContent({
        tags,
        userPubkey: ME,
        userEventIds: [MY_ROOT],
      })
    ).toBe(true);
  });

  it('classifies a root-only comment on my content (no parent tags) as direct reply', () => {
    const tags = [
      ['E', MY_ROOT],
      ['P', ME],
    ];
    expect(
      isDirectCommentToOwnContent({
        tags,
        userPubkey: ME,
        userEventIds: [MY_ROOT],
      })
    ).toBe(true);
  });

  it('classifies a comment on foreign content as thread reply', () => {
    const tags = [
      ['E', OTHER_NOTE],
      ['p', OTHER],
    ];
    expect(
      isDirectCommentToOwnContent({ tags, userPubkey: ME, userEventIds: [] })
    ).toBe(false);
  });
});
