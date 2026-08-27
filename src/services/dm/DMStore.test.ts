/**
 * DMStore — Migrations-QA auf NoorDB-Basis (fake-indexeddb).
 *
 * Deckt die kritischste historische Bugklasse ab: ein v4-artiger Datenstand
 * OHNE expiresAt-Index (der still fehlgeschlagene v4→v5-Upgrade-Pfad).
 * NoorDBs Schema-Reconciliation muss den Index beim Open auf v6 anlegen,
 * Legacy-Daten müssen erhalten bleiben, und der Expiry-Sweep muss danach
 * funktionieren. Zusätzlich: wrapId-Dedup, Unread-Bump, markAsRead.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  },
}));

vi.mock('../DiagnosticLogger', () => ({ diagLog: vi.fn() }));

/** Konfigurierbarer localStorage-Mirror-Fixture (DM_READ_ANCHORS). */
let readAnchorFixture: Record<string, number> = {};

vi.mock('../PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: {
    getInstance: () => ({
      getForPubkey: vi.fn((key: string) =>
        key === 'dm_read_anchors' ? readAnchorFixture : {}
      ),
      setForPubkey: vi.fn(),
    }),
  },
  StorageKeys: {
    DM_READ_ANCHORS: 'dm_read_anchors',
    DM_DISAPPEARING_SETTINGS: 'dm_disappearing',
  },
}));

import { DMStore, type DMMessage } from './DMStore';

const ME_LEGACY = 'a'.repeat(64);
const ME_UNREAD = 'c'.repeat(64);
const ME_PURGE = 'd'.repeat(64);
const PARTNER = 'b'.repeat(64);

function msg(
  partial: Partial<DMMessage> & Pick<DMMessage, 'id' | 'wrapId'>
): DMMessage {
  return {
    pubkey: PARTNER,
    content: 'hello',
    createdAt: 2_000,
    conversationWith: PARTNER,
    isMine: false,
    format: 'nip17',
    ...partial,
  };
}

/** Legacy-DB im v4-Zustand anlegen: OHNE expiresAt-Index (der v5-Bug). */
function seedLegacyV4Db(
  dbName: string,
  legacyMessage: DMMessage,
  lastReadAt: number
): Promise<void> {
  return new Promise(resolve => {
    const req = indexedDB.open(dbName, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('conversationWith', 'conversationWith');
        s.createIndex('createdAt', 'createdAt');
        s.createIndex('wrapId', 'wrapId', { unique: true });
        // expiresAt index deliberately MISSING — the v4/v5 bug state
      }
      if (!db.objectStoreNames.contains('conversations')) {
        const c = db.createObjectStore('conversations', { keyPath: 'pubkey' });
        c.createIndex('lastMessageAt', 'lastMessageAt');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['messages', 'conversations'], 'readwrite');
      tx.objectStore('messages').put(legacyMessage);
      tx.objectStore('conversations').put({
        pubkey: PARTNER,
        lastMessageAt: legacyMessage.createdAt,
        lastMessagePreview: legacyMessage.content,
        unreadCount: 0,
        lastReadAt,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    };
  });
}

let store: DMStore;

beforeEach(() => {
  (DMStore as unknown as { instance: null }).instance = null;
  readAnchorFixture = {};
  store = DMStore.getInstance();
});

afterEach(() => {
  store.close();
});

describe('DMStore on NoorDB', () => {
  it('heals a v4 DB missing the expiresAt index and preserves legacy data', async () => {
    const dbName = `noornote_dm_${ME_LEGACY}`;
    const legacy = msg({
      id: 'legacy1',
      wrapId: 'w-legacy1',
      content: 'old message',
      createdAt: 100,
    });
    await seedLegacyV4Db(dbName, legacy, 1_000);

    await store.init(ME_LEGACY);

    // Legacy message survived the upgrade
    const history = await store.getMessages(PARTNER);
    expect(history.map(m => m.id)).toContain('legacy1');

    // wrapId-Dedup greift über den Legacy-Bestand
    const dup = await store.saveMessage(
      msg({ id: 'dup', wrapId: 'w-legacy1', createdAt: 3_000 })
    );
    expect(dup.inserted).toBe(false);

    // Der Expiry-Sweep lief über den neu angelegten expiresAt-Index:
    // eine frische, abgelaufene Nachricht wird gelöscht, die Legacy-Nachricht
    // (ohne expiresAt) bleibt vom Index unberührt.
    await store.saveMessage(
      msg({ id: 'exp1', wrapId: 'w-exp1', createdAt: 1_500, expiresAt: 1_600 })
    );
    const sweep = await store.deleteExpiredBefore(2_000);
    expect(sweep.count).toBe(1);
    expect(sweep.partnerPubkeys.has(PARTNER)).toBe(true);

    const after = await store.getMessages(PARTNER);
    expect(after.map(m => m.id)).toEqual(['legacy1']);
  });

  it('bumps unread only for newer incoming messages and markAsRead resets', async () => {
    // Keine Conversation-Records — der localStorage-Mirror (lastReadAt=1000)
    // ist der Anker, exactly der Eviction-Fallback-Pfad aus saveMessage.
    readAnchorFixture = { [PARTNER]: 1000 };
    await store.init(ME_UNREAD);

    // Älter als Anker → kein Unread-Bump
    const old = await store.saveMessage(
      msg({ id: 'm2', wrapId: 'w2', createdAt: 900 })
    );
    expect(old.inserted).toBe(true);
    expect(old.unreadBumped).toBe(false);

    // Neuer als Anker → Unread-Bump
    const fresh = await store.saveMessage(
      msg({ id: 'm3', wrapId: 'w3', createdAt: 1_500 })
    );
    expect(fresh.inserted).toBe(true);
    expect(fresh.unreadBumped).toBe(true);

    expect(await store.getTotalUnreadCount()).toBe(1);

    await store.markAsRead(PARTNER);
    expect(await store.getTotalUnreadCount()).toBe(0);
    const conv = await store.getConversation(PARTNER);
    expect(conv?.unreadCount).toBe(0);
    expect(conv?.lastReadAt ?? 0).toBeGreaterThan(1_000);
  });

  it('purges a conversation with all its messages', async () => {
    await store.init(ME_PURGE);

    await store.saveMessage(msg({ id: 'p1', wrapId: 'wp1', createdAt: 1_000 }));
    await store.saveMessage(msg({ id: 'p2', wrapId: 'wp2', createdAt: 1_100 }));

    await store.purgeConversation(PARTNER);

    expect(await store.getMessages(PARTNER)).toEqual([]);
    expect(await store.getConversation(PARTNER)).toBeNull();
  });
});
