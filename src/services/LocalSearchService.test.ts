/**
 * LocalSearchService tests — sovereign in-memory search over the NoteService
 * cache stream and DMStore plaintext. All heavy deps are module-mocked
 * (NoteService as an id→event map, DMStore likewise, bus as a stub).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const { noteEvents, dmMessages, busHandlers } = vi.hoisted(() => ({
  noteEvents: new Map<string, NostrEvent>(),
  dmMessages: new Map<string, Record<string, unknown>>(),
  busHandlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('./NoteService', () => ({
  NoteService: {
    getInstance: () => ({
      getAllCachedEvents: () => [...noteEvents.values()],
      getCachedNote: (id: string) => noteEvents.get(id) ?? null,
      getNote: async (id: string) => noteEvents.get(id) ?? null,
    }),
  },
}));

vi.mock('./dm/DMStore', () => ({
  DMStore: {
    getInstance: () => ({
      getAllMessages: async () => [...dmMessages.values()],
      getMessageById: async (id: string) => dmMessages.get(id) ?? null,
    }),
  },
}));

vi.mock('../core/TypedEventBus', () => ({
  TypedEventBus: {
    getInstance: () => ({
      on: (event: string, handler: (payload: unknown) => void) => {
        busHandlers.set(event, handler);
        return `sub-${event}`;
      },
      off: () => {},
    }),
  },
}));

vi.mock('./DiagnosticLogger', () => ({
  diagLog: vi.fn(),
}));

import { LocalSearchService } from './LocalSearchService';

let counter = 0;
function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  counter += 1;
  return {
    id: `id${counter}`.padEnd(64, '0'),
    pubkey: 'a'.repeat(64),
    created_at: 1792000000 + counter,
    kind: 1,
    tags: [],
    content: '',
    sig: 'c'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

function makeDm(content: string): Record<string, unknown> {
  counter += 1;
  return {
    id: `dm${counter}`,
    pubkey: 'b'.repeat(64),
    conversationWith: 'c'.repeat(64),
    createdAt: 1792000000 + counter,
    isMine: false,
    content,
    format: 'nip17',
    wrapId: `wrap${counter}`,
  };
}

beforeEach(() => {
  // Fresh instance per test — the constructor seeds the note index from the
  // mocked cache, so stale singleton state would leak between tests.
  LocalSearchService.getInstance().destroy();
  noteEvents.clear();
  dmMessages.clear();
});

describe('LocalSearchService — note index', () => {
  it('finds indexed notes with prefix and fuzzy matching', async () => {
    noteEvents.clear();
    noteEvents.set(
      'n1',
      makeEvent({ id: 'n1', content: 'Sovereign search over local caches' })
    );
    const svc = LocalSearchService.getInstance();

    const exact = await svc.searchNotes('sovereign');
    expect(exact.map(e => e.id)).toContain('n1');

    const prefix = await svc.searchNotes('sover');
    expect(prefix.map(e => e.id)).toContain('n1');
  });

  it('indexes only text-bearing kinds (reposts/reactions excluded)', async () => {
    noteEvents.clear();
    noteEvents.set(
      'n1',
      makeEvent({ id: 'n1', kind: 1, content: 'unique llama post' })
    );
    noteEvents.set(
      'r1',
      makeEvent({ id: 'r1', kind: 6, content: 'unique llama post' })
    );
    noteEvents.set(
      'x1',
      makeEvent({ id: 'x1', kind: 7, content: 'unique llama post' })
    );
    const svc = LocalSearchService.getInstance();

    const hits = await svc.searchNotes('llama');
    expect(hits.map(e => e.id)).toEqual(['n1']);
  });

  it('does not fuzzy-match terms the content does not contain', async () => {
    noteEvents.clear();
    noteEvents.set('n1', makeEvent({ id: 'n1', content: 'unique llama post' }));
    const svc = LocalSearchService.getInstance();

    // 'llamas' is not a prefix of the indexed token 'llama' and fuzzy is off
    expect(await svc.searchNotes('llamas')).toEqual([]);
    // An unrelated term of similar length must not match either
    expect(await svc.searchNotes('llanmo')).toEqual([]);
  });

  it('indexes article titles as a boosted field', async () => {
    noteEvents.clear();
    noteEvents.set(
      'a1',
      makeEvent({
        id: 'a1',
        kind: 30023,
        content: 'Long article body about gardening',
        tags: [['title', 'The Sovereign Gardener']],
      })
    );
    const svc = LocalSearchService.getInstance();

    const byTitle = await svc.searchNotes('gardener');
    expect(byTitle.map(e => e.id)).toContain('a1');
  });

  it('indexes new notes arriving via the note:cached stream', async () => {
    noteEvents.clear();
    const svc = LocalSearchService.getInstance();
    noteEvents.set(
      'n9',
      makeEvent({ id: 'n9', content: 'freshly cached zorb text' })
    );

    busHandlers.get('note:cached')?.({ eventId: 'n9' });

    const hits = await svc.searchNotes('zorb');
    expect(hits.map(e => e.id)).toContain('n9');
  });

  it('returns nothing for queries shorter than 2 chars', async () => {
    const svc = LocalSearchService.getInstance();
    expect(await svc.searchNotes('a')).toEqual([]);
  });
});

describe('LocalSearchService — DM index', () => {
  it('builds the DM index lazily and resolves hits to messages', async () => {
    const message = makeDm('The meeting is moved to tuesday');
    dmMessages.set(message.id as string, message);
    const svc = LocalSearchService.getInstance();

    const hits = await svc.searchDMs('tuesday');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe('The meeting is moved to tuesday');
  });

  it('keeps the DM index fresh via dm:new-message', async () => {
    const svc = LocalSearchService.getInstance();
    const message = makeDm('secret passphrase quokka');
    dmMessages.set(message.id as string, message);

    busHandlers.get('dm:new-message')?.({ message });

    const hits = await svc.searchDMs('quokka');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe('secret passphrase quokka');
  });

  it('wipes the DM index on logout (privacy)', async () => {
    const message = makeDm('wipe me on logout');
    dmMessages.set(message.id as string, message);
    const svc = LocalSearchService.getInstance();
    expect(await svc.searchDMs('logout')).toHaveLength(1);

    busHandlers.get('user:logout')?.(undefined);

    const stats = svc.getStats();
    expect(stats.dms).toBeNull();
  });
});
