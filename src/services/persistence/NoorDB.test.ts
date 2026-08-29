/**
 * NoorDB — Tests für die zentrale Upgrade-Engine und den Promise-Wrapper.
 *
 * Abgedeckte Bugklassen (siehe docs/todos/persistence-centralization.md):
 *   - Schema-Reconciliation: ein Version-Bump heilt garantiert fehlgeschlagene
 *     partielle Upgrades (DMStore-v5-Bugklasse: still fehlende Indexe)
 *   - versionchange: alte Verbindung schließt sich selbst statt Upgrades
 *     anderer Tabs zu blockieren
 *   - Never-Throw (bestEffort) vs. fehlerwerfende Semantik
 *   - Lifecycle-Registry: closeAllPerAccountDatabases trifft nur per-account
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';

// DiagnosticLogger zieht transitiv AuthService → Signer-Managers → ProfileOrchestrator
// (letzterer liest localStorage auf Modulebene — kippt in der Node-Test-Umgebung).
// Für diese Tests ist diagLog ein No-Op (gleiches Muster wie UserProfileService.test.ts).
vi.mock('../DiagnosticLogger', () => ({ diagLog: () => {} }));

import {
  openDb,
  perAccountDbName,
  globalDbName,
  closeAllPerAccountDatabases,
  listOpenDatabases,
  type NoorDatabase,
} from './NoorDB';

interface MetaEntry {
  k: string;
  ranAt: number;
}

const openedDbs: NoorDatabase[] = [];

function track(db: NoorDatabase): NoorDatabase {
  openedDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openedDbs.splice(0)) {
    db.close();
  }
});

describe('NoorDB naming', () => {
  it('builds per-account names as noornote-{slug}-{npub}', () => {
    expect(perAccountDbName('analytics', 'npub1abc')).toBe(
      'noornote-analytics-npub1abc'
    );
    expect(perAccountDbName('dm', 'npub1xyz')).toBe('noornote-dm-npub1xyz');
  });

  it('builds global names as noornote-{slug}', () => {
    expect(globalDbName('secure')).toBe('noornote-secure');
    expect(globalDbName('nip65_cache')).toBe('noornote-nip65_cache');
  });
});

describe('NoorDB basic operations', () => {
  it('creates declared stores and indexes on fresh open and round-trips values', async () => {
    const db = track(
      await openDb('test-basic-v1', {
        version: 1,
        stores: [
          {
            name: 'snapshots',
            keyPath: 'id',
            indexes: [{ name: 'byDate', keyPath: 'date' }],
          },
          { name: 'runs', autoIncrement: true },
        ],
      })
    );

    await db.put('snapshots', {
      id: 'posts',
      metrics: { originals: 3 },
      date: 100,
    });
    const loaded = await db.get<{ id: string; metrics: { originals: number } }>(
      'snapshots',
      'posts'
    );
    expect(loaded?.metrics.originals).toBe(3);
    expect(loaded?.date).toBe(100);

    await db.put('runs', { label: 'first' });
    expect(await db.count('runs')).toBe(1);
  });

  it('supports out-of-line keys for stores without keyPath', async () => {
    const db = track(
      await openDb('test-outofline', {
        version: 1,
        stores: [{ name: 'degrees' }],
      })
    );

    await db.put('degrees', { pubkeys: ['a', 'b'] }, 2);
    const loaded = await db.get<{ pubkeys: string[] }>('degrees', 2);
    expect(loaded?.pubkeys).toEqual(['a', 'b']);
  });

  it('getAll / delete / clear behave', async () => {
    const db = track(
      await openDb('test-crud', {
        version: 1,
        stores: [{ name: 'items', keyPath: 'k' }],
      })
    );

    await db.put('items', { k: 'a', v: 1 });
    await db.put('items', { k: 'b', v: 2 });
    await db.put('items', { k: 'c', v: 3 });

    expect((await db.getAll<{ k: string }>('items')).length).toBe(3);
    await db.delete('items', 'b');
    expect(await db.count('items')).toBe(2);
    await db.clear('items');
    expect(await db.count('items')).toBe(0);
  });

  it('withStore gives raw access inside a completed transaction', async () => {
    const db = track(
      await openDb('test-withstore', {
        version: 1,
        stores: [{ name: 'items', keyPath: 'k' }],
      })
    );

    await db.withStore('items', 'readwrite', store => {
      store.put({ k: 'a', v: 1 });
      store.put({ k: 'b', v: 2 });
    });

    const names = await db.withStore('items', 'readonly', store => {
      const out: string[] = [];
      return new Promise<string[]>(resolve => {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            out.push(String((cursor.value as { k: string }).k));
            cursor.continue();
          } else {
            resolve(out);
          }
        };
      });
    });
    expect(names).toEqual(['a', 'b']);
  });

  it('withTransaction spans multiple stores atomically and exposes the version', async () => {
    const db = track(
      await openDb('test-multistore', {
        version: 3,
        stores: [
          { name: 'messages', keyPath: 'id' },
          { name: 'conversations', keyPath: 'pubkey' },
        ],
      })
    );
    expect(db.version).toBe(3);

    await db.withTransaction(['messages', 'conversations'], 'readwrite', tx => {
      tx.objectStore('messages').put({ id: 'm1', conversationWith: 'p1' });
      tx.objectStore('conversations').put({ pubkey: 'p1', unreadCount: 1 });
    });

    const msg = await db.get<{ id: string }>('messages', 'm1');
    const conv = await db.get<{ pubkey: string }>('conversations', 'p1');
    expect(msg?.id).toBe('m1');
    expect(conv?.pubkey).toBe('p1');
  });
});

describe('NoorDB upgrade engine', () => {
  it('runs migration steps in version order and only for crossed boundaries', async () => {
    const baseDef = { stores: [{ name: 'meta', keyPath: 'k' } as const] };

    const v1 = track(
      await openDb('test-upgrade-chain', { ...baseDef, version: 1 })
    );
    await v1.put('meta', { k: 'seed', ranAt: 0 } satisfies MetaEntry);
    v1.close();

    const v2 = track(
      await openDb('test-upgrade-chain', {
        ...baseDef,
        version: 2,
        upgrades: [
          {
            fromVersion: 1,
            toVersion: 2,
            migrate: (_db, tx) => {
              tx.objectStore('meta').put({
                k: 'step-1-2',
                ranAt: 2,
              } satisfies MetaEntry);
            },
          },
        ],
      })
    );
    const afterV2 = await v2.get<MetaEntry>('meta', 'step-1-2');
    expect(afterV2?.ranAt).toBe(2);
    v2.close();

    const v3 = track(
      await openDb('test-upgrade-chain', {
        ...baseDef,
        version: 3,
        upgrades: [
          {
            fromVersion: 1,
            toVersion: 2,
            migrate: (_db, tx) => {
              tx.objectStore('meta').put({
                k: 'step-1-2',
                ranAt: 22,
              } satisfies MetaEntry);
            },
          },
          {
            fromVersion: 2,
            toVersion: 3,
            migrate: (_db, tx) => {
              tx.objectStore('meta').put({
                k: 'step-2-3',
                ranAt: 3,
              } satisfies MetaEntry);
            },
          },
        ],
      })
    );

    // 1→2 darf NICHT erneut gelaufen sein (ranAt blieb 2), 2→3 genau einmal.
    expect((await v3.get<MetaEntry>('meta', 'step-1-2'))?.ranAt).toBe(2);
    expect((await v3.get<MetaEntry>('meta', 'step-2-3'))?.ranAt).toBe(3);
    expect((await v3.get<MetaEntry>('meta', 'seed'))?.ranAt).toBe(0);
  });

  it('re-issues missing indexes on the next version bump (DMStore-v5 bug class)', async () => {
    // Raw-DB v1 anlegen: Store OHNE den später deklarierten Index — simuliert
    // ein früher fehlgeschlagenes partielles Upgrade.
    const rawName = 'test-reissue';
    await new Promise<void>(resolve => {
      const req = indexedDB.open(rawName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('messages', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });

    const db = track(
      await openDb(rawName, {
        version: 2,
        stores: [
          {
            name: 'messages',
            keyPath: 'id',
            indexes: [{ name: 'expiresAt', keyPath: 'expiresAt' }],
          },
        ],
      })
    );

    await db.put('messages', { id: 'm1', expiresAt: 42 });
    const hasIndex = await db.withStore('messages', 'readonly', store =>
      store.indexNames.contains('expiresAt')
    );
    expect(hasIndex).toBe(true);
    expect(await db.count('messages')).toBe(1);
  });
});

describe('NoorDB connection lifecycle', () => {
  it('auto-closes on versionchange so other connections can upgrade', async () => {
    const name = 'test-versionchange';
    const def = { stores: [{ name: 'items', keyPath: 'k' }] };
    const connA = track(await openDb(name, { ...def, version: 1 }));
    await connA.put('items', { k: 'a', v: 1 });

    const connB = track(await openDb(name, { ...def, version: 2 }));
    expect(connB.isOpen).toBe(true);
    expect(connA.isOpen).toBe(false);

    // Neue Ops auf der geschlossenen Verbindung werfen (non-bestEffort) …
    await expect(connA.get('items', 'a')).rejects.toThrow(/closed/);
    // … und die upgradende Verbindung sieht die Daten.
    expect(await connB.get<{ k: string; v: number }>('items', 'a')).toEqual({
      k: 'a',
      v: 1,
    });
  });

  it('bestEffort swallows operation errors, default semantics reject', async () => {
    const def = { stores: [{ name: 'items', keyPath: 'k' }] };
    const strict = track(await openDb('test-strict', { ...def, version: 1 }));
    const lenient = track(
      await openDb('test-lenient', { ...def, version: 1, bestEffort: true })
    );

    strict.close();
    lenient.close();

    await expect(strict.get('items', 'a')).rejects.toThrow();
    await expect(lenient.get('items', 'a')).resolves.toBeUndefined();
    await expect(lenient.getAll('items')).resolves.toEqual([]);
    await expect(lenient.put('items', { k: 'a' })).resolves.toBeUndefined();
    await expect(lenient.count('items')).resolves.toBe(0);
  });

  it('closeAllPerAccountDatabases closes only per-account connections', async () => {
    const def = { stores: [{ name: 'items', keyPath: 'k' }] };

    const perAccount = track(
      await openDb(
        'test-pa-account',
        { ...def, version: 1 },
        { perAccount: true }
      )
    );
    const perAccount2 = track(
      await openDb(
        'test-pa-account-2',
        { ...def, version: 1 },
        { perAccount: true }
      )
    );
    const global = track(
      await openDb('test-pa-global', { ...def, version: 1 })
    );

    closeAllPerAccountDatabases();

    expect(perAccount.isOpen).toBe(false);
    expect(perAccount2.isOpen).toBe(false);
    expect(global.isOpen).toBe(true);

    const stillOpen = listOpenDatabases().filter(c => c.open);
    expect(stillOpen.map(c => c.name)).toEqual(['test-pa-global']);
  });

  it('removes closed connections from the registry', async () => {
    const def = { stores: [{ name: 'items', keyPath: 'k' }] };
    const db = track(await openDb('test-registry', def));
    expect(listOpenDatabases().some(c => c.name === 'test-registry')).toBe(
      true
    );
    db.close();
    expect(listOpenDatabases().some(c => c.name === 'test-registry')).toBe(
      false
    );
    expect(db.isOpen).toBe(false);
  });
});
