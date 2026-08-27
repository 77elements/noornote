# NoorDB — zentrale IndexedDB-Infrastruktur

Seit 2026-08-27 läuft **jeder** IndexedDB-Zugriff in NoorNote durch NoorDB
(`src/services/persistence/NoorDB.ts`). Vorher rollten 10 Stores je ~80–130 LOC
eigenes open/upgrade/tx-Boilerplate — die DMStore-v5-Bugklasse (still
fehlgeschlagene Index-Erstellung durch hand-gerollte Upgrade-Pfade und stale
Connections) war die wiederkehrende Folge. Plan + Historie:
`docs/todos/persistence-centralization.md`.

Durchgesetzt via `/build-validate` Step 27 (IndexedDB Centralization Guard):
`indexedDB.open` darf nur noch in `NoorDB.ts` vorkommen.

## Quick Start

### Neue DB anlegen (Naming-Konvention ist erzwungen)

```ts
import { openPerAccountDb, globalDbName, openDb } from '../persistence/NoorDB';

// Per-Account (der aktuell eingeloggte User, npub-basiert):
const db = await openPerAccountDb('analytics', {
  version: 1,
  stores: [
    { name: 'snapshots', keyPath: 'id' },
    { name: 'runs', autoIncrement: true },
  ],
});
// → DB-Name: noornote-analytics-{npub}, als perAccount registriert
// (wird bei Account-Wechsel/Logout automatisch geschlossen)

// Global (account-unabhängig):
const db = await openDb(globalDbName('myfeature'), { version: 1, stores: [...] });
```

`perAccountDbName(slug, npub)` ist die pure Variante (npub explizit, testbar).

### Schema deklarieren — die Engine reconciled

```ts
const def: NoorDbDefinition = {
  version: 2,
  stores: [{
    name: 'messages',
    keyPath: 'id',
    indexes: [
      { name: 'createdAt', keyPath: 'createdAt' },
      { name: 'wrapId', keyPath: 'wrapId', unique: true },
    ],
  }],
  upgrades: [{
    fromVersion: 1,
    toVersion: 2,
    migrate: (_db, tx) => {
      tx.objectStore('messages').put({ id: 'marker', ranAt: 2 });
    },
  }],
};
```

**Garantie:** Bei JEDEM `onupgradeneeded` gleichen Engine-Reconciliation und
Migration-Steps den Ist-Zustand an die Deklaration ab (fehlende Stores/Indexe
werden ergänzt — idempotent). Ein Version-Bump heilt damit garantiert jedes
früher fehlgeschlagene partielle Upgrade. Migration-Steps laufen nur für
überquerte Versiongrenzen und innerhalb der Upgrade-Transaction
(in der `migrate(_db, tx)` NUR `tx` verwenden — niemals `db.transaction()`,
das wirft während Upgrades).

### CRUD

```ts
await db.put('snapshots', { id: 'posts', count: 3 });        // in-line key
await db.put('degrees', entry, 2);                           // out-of-line key
const x = await db.get<{ id: string }>('snapshots', 'posts'); // undefined wenn fehlt
const all = await db.getAll<Snap>('snapshots');
await db.delete('snapshots', 'posts');
const n = await db.count('snapshots');
await db.clear('snapshots');
```

### Raw-Zugriff (Cursor, Index-Queries, Bulk) — der Escape-Hatch

```ts
// Single-Store:
await db.withStore('messages', 'readwrite', store => {
  for (const m of batch) void store.put(m);
});
const oldest = await db.withStore('messages', 'readonly', store =>
  new Promise(resolve => {
    const req = store.index('createdAt').openCursor();
    req.onsuccess = () => resolve(req.result?.value ?? null);
  })
);

// Multi-Store (atomar über Store-Grenzen):
await db.withTransaction(['messages', 'conversations'], 'readwrite', tx => {
  tx.objectStore('messages').put(msg);
  tx.objectStore('conversations').put(conv);
});
```

`withStore`/`withTransaction` lösen erst nach Transaction-Complete auf und
werfen IMMER bei Fehlern (auch mit `bestEffort`) — der Aufrufer hat hier
Low-Level-Kontrolle übernommen. Async-Work innerhalb des Callbacks ist
sicher, solange neue Requests aus dem Success-Event-Microtask heraus
gestellt werden (Standard-idb-Pattern; siehe `DiagWebStore.prune`).

### Never-Throw (`bestEffort`)

```ts
const def = { version: 1, stores: [...], bestEffort: true };
```

Reads lösen zu `undefined`/`[]` auf, Writes schlucken Fehler (mit diagLog).
Für Stores, deren Persistenz nur Best-Effort-Optimierung ist (FoafStore,
ProfileStore). Default: `false` — Fehler werden geworfen, der Caller
reagiert (DMStore-Art).

## Lifecycle

- Jede offene Verbindung wird in einer Registry geführt.
- `closeAllPerAccountDatabases()` schließt alle als `perAccount` eröffneten
  Verbindungen — verdrahtet in `PostLoginService` (Account-Wechsel) und
  `App.ts` (`user:logout`). Fixt die Bugklasse „stale DB-Handle nach
  Account-Wechsel".
- `onversionchange`: schließt die Verbindung sauber selbst (closed-Flag,
  Registry-Austrag), statt künftige Upgrades anderer Tabs zu blockieren.
  Consumer prüfen `db.isOpen` bzw. fangen den InvalidStateError.
- `onblocked`: diagLog statt stillem Hänger.
- Kein instanz-Caching über Caller hinweg: Der konsumierende Service besitzt
  den Lebenszyklus (Singleton-Pattern wie bisher). Typisches Muster:
  `ensureDb()` mit `if (this.db?.isOpen) return this.db;` — nach einem
  versionchange-Auto-Close wird transparent neu geöffnet.

## Migrations-Regeln für Bestands-Stores

1. DB-Name, Object-Stores, Versionen und Indexe bleiben **bit-identisch** —
   nur open/upgrade/tx-Boilerplate wird durch NoorDB-Aufrufe ersetzt.
   Legacy-Namen (z.B. `noornote_dm_{pubkey-hex}`, underscore-Ära) werden
   as-is an `openDb()` übergeben — Umbenennung verwaistet Daten.
2. Fehler-Semantik bleibt: Never-Throw-Stores → `bestEffort: true`;
   fehlerwerfende Stores → Default + bestehende Try/Catches.
3. Bewusst erlaubte Mini-Verbesserungen bei der Migration ( dokumentiert im
   Plan): In-Flight-Caches werden nach Abschluss geleert → Retry nach
   Failed-Open statt dauerhaft degradiert; sauberes Re-Open nach
   versionchange.

## Testing

`fake-indexeddb` (devDependency) + `vi.mock` der schweren Logger-Ketten:

```ts
import 'fake-indexeddb/auto';
vi.mock('../DiagnosticLogger', () => ({ diagLog: () => {} }));
```

Referenzen: `NoorDB.test.ts` (Engine: Upgrade-Ketten, versionchange,
Index-Re-Issue, bestEffort, Registry), `DMStore.test.ts` (v4-Heilung ohne
expiresAt-Index, Legacy-Daten, Dedup, Sweep, Unread-Anker).

## Migrierte Stores (Stand 2026-08-27)

Global: OutboundRelaysOrchestrator (`noornote_nip65_cache`),
DeleteBroadcastStore (`noornote_delete_broadcast`), KeychainStorage
(`noornote_secure`), NWCCryptoService (`noornote_device`).

Per-Account: FoafStore (`noornote-foaf-{npub}`), DiagWebStore
(`noornote-diag-{npub}`), ProfileStore (`noornote-profiles-{npub}`),
NoteTakingStore (`noornote_note_taking_{pubkey}`), DMStore
(`noornote_dm_{pubkey}`, v6).

Nicht über NoorDB (bewusst): NDK-interner Dexie-Cache (fremde Library),
`PerAccountLocalStorage` (localStorage, bereits zentral),
`BaseFileStorage`/`EncryptedFileStorage` (Dateien, bereits zentral).
