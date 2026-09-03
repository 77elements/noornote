import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { buildThreadTree, extractReplyParentId } from './threadTree';

function makeReply(id: string, tags: string[][], kind: number = 1): NostrEvent {
  return {
    id,
    kind,
    pubkey: `pk-${id}`,
    created_at: 1700000000,
    content: `reply ${id}`,
    tags,
  } as unknown as NostrEvent;
}

describe('extractReplyParentId', () => {
  it('NIP-22 kind:1111 — uses the lowercase e-tag, not markers', () => {
    const reply = makeReply(
      'c1',
      [
        ['e', 'root1111', '', 'root'],
        ['p', 'author'],
      ],
      1111
    );
    // First 'e' tag is the parent reference for kind:1111
    expect(extractReplyParentId(reply)).toBe('root1111');
  });

  it('NIP-10 kind:1 — explicit reply marker wins over other e-tags', () => {
    const reply = makeReply('r1', [
      ['e', 'rootId', '', 'root'],
      ['e', 'parentId', '', 'reply'],
      ['p', 'author'],
    ]);
    expect(extractReplyParentId(reply)).toBe('parentId');
  });

  it('NIP-10 kind:1 — falls back to the last e-tag (deprecated form)', () => {
    const reply = makeReply('r2', [
      ['e', 'someId'],
      ['e', 'lastId'],
    ]);
    expect(extractReplyParentId(reply)).toBe('lastId');
  });

  it('returns null when there are no e-tags', () => {
    expect(extractReplyParentId(makeReply('r3', [['p', 'author']]))).toBeNull();
  });
});

describe('buildThreadTree', () => {
  it('nests child replies under their parents and flattens orphans to root', () => {
    const root = 'rootId';
    const direct1 = makeReply('d1', [
      ['e', root, '', 'root'],
      ['e', root, '', 'reply'],
    ]);
    const child = makeReply('c1', [
      ['e', root, '', 'root'],
      ['e', 'd1', '', 'reply'],
    ]);
    const direct2 = makeReply('d2', [
      ['e', root, '', 'root'],
      ['e', root, '', 'reply'],
    ]);
    // Parent not in the set → must become a root node, not disappear
    const orphan = makeReply('orphan', [['e', 'ghostId', '', 'reply']]);

    const tree = buildThreadTree([direct1, child, direct2, orphan], root);

    expect(tree).toHaveLength(3);
    expect(tree.map(n => n.event.id)).toEqual(['d1', 'd2', 'orphan']);

    const d1Node = tree.find(n => n.event.id === 'd1')!;
    expect(d1Node.depth).toBe(0);
    expect(d1Node.children).toHaveLength(1);
    expect(d1Node.children[0]!.event.id).toBe('c1');
    expect(d1Node.children[0]!.depth).toBe(1);
  });

  it('treats a reply-to-root as a top-level node', () => {
    const reply = makeReply('r1', [['e', 'rootId']]);
    const tree = buildThreadTree([reply], 'rootId');
    expect(tree).toHaveLength(1);
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.children).toHaveLength(0);
  });

  it('nests kind:1111 comments by their first e-tag (NIP-22)', () => {
    const root = 'kind1root';
    const comment = makeReply(
      'k1',
      [
        ['e', root],
        ['p', 'author'],
      ],
      1111
    );
    const nested = makeReply('k2', [['e', 'k1']], 1111);

    const tree = buildThreadTree([comment, nested], root);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.event.id).toBe('k1');
    expect(tree[0]!.children[0]!.event.id).toBe('k2');
  });
});
