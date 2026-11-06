/**
 * Tests for the pure mention/reply classifier of the Group Chats addon.
 *
 * Classification drives the addon's high-priority notification: a p tag on
 * the user's pubkey (mention) or a q/e tag whose author element is the user
 * (reply). Own events and unattributable references must never notify.
 */

import { describe, it, expect } from 'vitest';
import { classifyActivity } from './activity';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const ME = 'f527cf970ce260e74261214bf612e8f75a59db1835ed7e4053326c3f65e232ee';
const OTHER =
  'e0921d610ee655396cfac6c9907b6ad11f3a1dde5770029e1284e6cae0fe7bd5';
const GROUP = 'bitcoin-majlis-b8rqg';

function event(
  pubkey: string,
  tags: string[][],
  content = 'hello'
): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey,
    kind: 9,
    created_at: 1792766113,
    tags: [['h', GROUP], ...tags],
    content,
    sig: 'b'.repeat(128),
  } as NostrEvent;
}

describe('classifyActivity — Group Chats mention/reply detection', () => {
  it('detects a p-tag mention on the user', () => {
    const { mentions, replies } = classifyActivity(
      [event(OTHER, [['p', ME, 'wss://relay.example']])],
      ME
    );
    expect(mentions).toHaveLength(1);
    expect(replies).toHaveLength(0);
  });

  it('detects a reply via a q tag with the user as author element', () => {
    // MeshCat chat-reply shape: ["q", quotedId, relay, quotedAuthor]
    const { mentions, replies } = classifyActivity(
      [event(OTHER, [['q', 'c'.repeat(64), 'wss://relay.example', ME]])],
      ME
    );
    expect(replies).toHaveLength(1);
    expect(mentions).toHaveLength(0);
  });

  it('ignores a q/e tag without an author element (unattributable)', () => {
    const { mentions, replies } = classifyActivity(
      [
        event(OTHER, [['q', 'c'.repeat(64), 'wss://relay.example']]),
        event(OTHER, [['e', 'c'.repeat(64), 'wss://relay.example']]),
      ],
      ME
    );
    expect(mentions).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it("ignores the user's own events, even self-tagging ones", () => {
    const { mentions, replies } = classifyActivity(
      [
        event(ME, [
          ['p', ME],
          ['q', 'c'.repeat(64), 'wss://relay.example', ME],
        ]),
      ],
      ME
    );
    expect(mentions).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it('counts mentions and replies separately in one window', () => {
    const { mentions, replies } = classifyActivity(
      [
        event(OTHER, [['p', ME]]),
        event(OTHER, [['q', 'c'.repeat(64), 'wss://relay.example', ME]]),
        event(OTHER, []), // plain activity
      ],
      ME
    );
    expect(mentions).toHaveLength(1);
    expect(replies).toHaveLength(1);
  });

  it('ignores p tags that point at someone else', () => {
    const { mentions, replies } = classifyActivity(
      [event(OTHER, [['p', OTHER]])],
      ME
    );
    expect(mentions).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});
