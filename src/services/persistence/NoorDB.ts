/**
 * NoorDB — zentrale IndexedDB-Infrastruktur für NoorNote.
 *
 * Ersetzt das bis 2026-08 in 10 Stores hand-gerollte open/upgrade/tx-Boilerplate
 * (je ~80–130 LOC) durch EINEN getesteten Kern:
 *
 *   - Naming-Konvention: perAccountDbName('analytics') → `noornote-analytics-{npub}`
 *     (dash + npub), globalDbName('secure') → `noornote-{slug}`.
 *     Legacy-DB-Namen (underscore/pubkey-Ära) bleiben gültig — Migrationen
 *     übergeben den alten Namen an openDb, Daten werden nie verwaist.
 *   - Schema-deklaratives Öffnen: openDb(name, definition) reconciliert auf
 *     JEDEM onupgradeneeded die deklarierten Stores+Indexe gegen den Ist-Zustand
 *     (fehlendes wird ergänzt). Eine Version-Bump heilt damit garantiert jedes
 *     früher fehlgeschlagene Upgrade — die DMStore-v5-Bugklasse (still
 *     fehlgeschlagene Index-Erstellung) kann nicht mehr entstehen.
 *   - Upgrade-Engine: Versions-Kette (v1→v2→…), custom MigrationSteps laufen
 *     in der Upgrade-Transaction, onblocked → diagLog statt stillem Hänger.
 *   - onversionchange → Verbindung schließt sich SAUBER selbst (closed-Flag),
 *     statt als stale Handle künftige Upgrades anderer Tabs zu blockieren.
 *   - Promise-Wrapper: get/put/getAll/delete/count/clear + withStore-Escape-
 *     Hatch für Raw-Operationen (Cursor, Index-Queries).
 *   - Never-Throw-Option (bestEffort): Reads → undefined/[], Writes → swallow
 *     + diagLog. Semantik nach FoafStore-Art, aber als Flag statt Kopie.
 *   - Lifecycle-Registry: jede offene DB wird registriert;
 *     closeAllPerAccountDatabases() schließt bei Account-Wechsel/Logout alle
 *     per-account-Verbindungen — fixt die Bugklasse „stale DB-Handle nach
 *     Account-Wechsel".
 *
 * Bewusst NICHT enthalten: Instanz-Caching/In-Flight-Dedup über Caller hinweg.
 * Lebenszyklus-Ownership bleibt beim konsumierenden Service (Singleton-Muster
 * wie bisher); NoorDB sorgt nur für korrektes open/upgrade/close.
 *
 * @used-by (nach Migration R1–R3): OutboundRelaysOrchestrator, DeleteBroadcastStore,
 *          KeychainStorage, NWCCryptoService, FoafStore, DiagWebStore, ProfileStore,
 *          NoteTakingStore, DMStore — und alle neuen Stores (z.B. AnalyticsStore)
 */

import { diagLog } from '../DiagnosticLogger';

/** Index-Definition eines ObjectStores. */
export interface NoorDbIndexSpec {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
  multiEntry?: boolean;
}

/** ObjectStore-Definition (Reconciliation-Zielzustand). */
export interface NoorDbStoreSpec {
  name: string;
  /** In-line keyPath; weglassen für out-of-line keys (put mit explizitem Key). */
  keyPath?: string;
  autoIncrement?: boolean;
  indexes?: NoorDbIndexSpec[];
}

/** Eigene Daten-Migration zwischen zwei Versionen (läuft in der Upgrade-Tx). */
export interface NoorDbMigrationStep {
  fromVersion: number;
  toVersion: number;
  migrate(db: IDBDatabase, tx: IDBTransaction): void;
}

export interface NoorDbDefinition {
  version: number;
  stores: NoorDbStoreSpec[];
  upgrades?: NoorDbMigrationStep[];
  /**
   * Never-Throw-Semantik: Reads lösen zu undefined/[] auf, Writes schlucken
   * Fehler (mit diagLog). Default false — DMStore-artige Consumer wollen
   * Fehler sehen und selbst reagieren.
   */
  bestEffort?: boolean;
}

export interface OpenDbOptions {
  /** true → DB wird bei Account-Wechsel/Logout durch die Registry geschlossen. */
  perAccount?: boolean;
}

/** Öffene Verbindung (Registry-Eintrag). */
interface OpenConnection {
  database: NoorDatabase;
  name: string;
  perAccount: boolean;
}

const registry = new Set<OpenConnection>();

/** DB-Name für einen globalen (account-unabhängigen) Store. */
export function globalDbName(slug: string): string {
  return `noornote-${slug}`;
}

/**
 * DB-Name für einen per-account-Store. `npub` ist bewusst explizit (pure,
 * testbar) — für den Current-User-Fall `openPerAccountDb` verwenden.
 */
export function perAccountDbName(slug: string, npub: string): string {
  return `noornote-${slug}-${npub}`;
}

/**
 * Per-account-DB des aktuell eingeloggten Users öffnen. Wirft, wenn kein
 * User eingeloggt ist (Caller zeigt Fehler/fällt auf Empty-State zurück).
 * AuthService wird lazy importiert, damit NoorDB selbst testbar und leicht bleibt.
 */
export async function openPerAccountDb(
  slug: string,
  definition: NoorDbDefinition
): Promise<NoorDatabase> {
  const { AuthService } = await import('../AuthService');
  const npub = AuthService.getInstance().getCurrentUser()?.npub;
  if (!npub) {
    throw new Error(
      `NoorDB: cannot open per-account db "${slug}" — no current user`
    );
  }
  return openDb(perAccountDbName(slug, npub), definition, { perAccount: true });
}

/**
 * DB öffnen (der zentrale Einstieg). Führt bei Bedarf die Upgrade-Engine aus:
 * deklarierte Stores/Indexe werden gegen den Ist-Zustand reconciled (fehlende
 * ergänzt — idempotent), anschließend laufen die passenden MigrationSteps.
 */
export function openDb(
  name: string,
  definition: NoorDbDefinition,
  opts?: OpenDbOptions
): Promise<NoorDatabase> {
  return new Promise<NoorDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, definition.version);

    request.onerror = () => {
      diagLog('system', 'NoorDB: open failed', {
        name,
        error: String(request.error),
      });
      reject(request.error ?? new Error(`NoorDB: open "${name}" failed`));
    };

    request.onblocked = () => {
      // Andere Verbindung hält die alte Version und reagiert nicht auf unser
      // Versionchange. open() bleibt pendent, bis sie schließt. Häufigste
      // Ursache: HMR/stale Handle — dank unseres onversionchange-Auto-Close
      // künftig nur noch von Fremd-Tabs verursachbar.
      diagLog('system', 'NoorDB: upgrade blocked by stale connection', {
        name,
        version: definition.version,
      });
    };

    request.onupgradeneeded = event => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) {
        diagLog('system', 'NoorDB: upgrade without transaction', { name });
        return;
      }
      reconcileSchema(db, tx, definition, event.oldVersion, name);
      runMigrationSteps(db, tx, definition, event.oldVersion, name);
    };

    request.onsuccess = () => {
      const raw = request.result;
      const database = new NoorDatabase(raw, name, definition);
      const connection: OpenConnection = {
        database,
        name,
        perAccount: opts?.perAccount === true,
      };

      raw.onversionchange = () => {
        // Eine andere Verbindung will upgraden: sofort freigeben, damit deren
        // Upgrade nicht blockiert wird. Handle wird als geschlossen markiert;
        // laufende Reads laufen noch zu Ende (IDB-spezifisch), neue Ops nicht mehr.
        diagLog('system', 'NoorDB: versionchange — closing connection', {
          name,
        });
        raw.close();
        database.markClosedByVersionChange();
        unregister(connection);
      };

      register(connection);
      resolve(database);
    };
  });
}

function register(connection: OpenConnection): void {
  registry.add(connection);
}

function unregister(connection: OpenConnection): void {
  registry.delete(connection);
}

/**
 * Reconcile: deklarierte Stores + Indexe gegen den Ist-Zustand der DB
 * ausgleichen. Läuft bei JEDEM Upgrade (unabhängig von der Version, von der
 * gekommen wird) — dadurch ist ein Version-Bump allein schon Reparatur für
 * jedes früher fehlgeschlagene partielle Upgrade.
 */
function reconcileSchema(
  db: IDBDatabase,
  tx: IDBTransaction,
  definition: NoorDbDefinition,
  oldVersion: number,
  dbName: string
): void {
  for (const spec of definition.stores) {
    if (!db.objectStoreNames.contains(spec.name)) {
      const options: IDBObjectStoreParameters = {
        autoIncrement: spec.autoIncrement === true,
      };
      if (spec.keyPath !== undefined) options.keyPath = spec.keyPath;
      db.createObjectStore(spec.name, options);
      diagLog('system', 'NoorDB: store created during upgrade', {
        db: dbName,
        store: spec.name,
        fromVersion: oldVersion,
      });
    }
    if (!tx.objectStoreNames.contains(spec.name)) continue;
    const store = tx.objectStore(spec.name);
    for (const indexSpec of spec.indexes ?? []) {
      if (!store.indexNames.contains(indexSpec.name)) {
        store.createIndex(indexSpec.name, indexSpec.keyPath, {
          unique: indexSpec.unique === true,
          multiEntry: indexSpec.multiEntry === true,
        });
        diagLog('system', 'NoorDB: index created during upgrade', {
          db: dbName,
          store: spec.name,
          index: indexSpec.name,
          fromVersion: oldVersion,
        });
      }
    }
  }
}

/** Passende MigrationSteps (aufsteigend) in der Upgrade-Tx ausführen. */
function runMigrationSteps(
  db: IDBDatabase,
  tx: IDBTransaction,
  definition: NoorDbDefinition,
  oldVersion: number,
  dbName: string
): void {
  const steps = [...(definition.upgrades ?? [])]
    .filter(
      s => s.fromVersion >= oldVersion && s.toVersion <= definition.version
    )
    .sort((a, b) => a.fromVersion - b.fromVersion);
  for (const step of steps) {
    try {
      step.migrate(db, tx);
      diagLog('system', 'NoorDB: migration step applied', {
        db: dbName,
        from: step.fromVersion,
        to: step.toVersion,
      });
    } catch (err) {
      diagLog('system', 'NoorDB: migration step failed', {
        db: dbName,
        from: step.fromVersion,
        to: step.toVersion,
        error: String(err),
      });
      throw err;
    }
  }
}

/**
 * Getestete Promise-Verbindung über einer IDBDatabase. Alle Convenience-Ops
 * öffnen ihre eigene Transaction; mit withStore() ist Raw-Zugriff (Cursor,
 * Index-Queries, Multi-Store-Tx) möglich.
 */
export class NoorDatabase {
  private rawDb: IDBDatabase | null;
  private closed = false;
  private readonly name: string;
  private readonly bestEffort: boolean;

  constructor(rawDb: IDBDatabase, name: string, definition: NoorDbDefinition) {
    this.rawDb = rawDb;
    this.name = name;
    this.bestEffort = definition.bestEffort === true;
  }

  public get isOpen(): boolean {
    return !this.closed;
  }

  public get dbName(): string {
    return this.name;
  }

  /** Aktuelle DB-Version (null wenn geschlossen) — z.B. für Recovery-Reopens. */
  public get version(): number | null {
    return this.rawDb?.version ?? null;
  }

  /** Von NoorDB nach onversionchange gesetzt (Verbindung wurde schon geschlossen). */
  public markClosedByVersionChange(): void {
    this.closed = true;
    this.rawDb = null;
  }

  /** Verbindung schließen (idempotent) und aus der Registry entfernen. */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rawDb?.close();
    this.rawDb = null;
    removeFromRegistry(this);
  }

  public async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    try {
      const objectStore = this.requireStore(store, 'readonly');
      return await wrapRequest<T | undefined>(
        objectStore.get(key) as IDBRequest<T | undefined>
      );
    } catch (err) {
      return this.handleOpError<T | undefined>('get', store, err, undefined);
    }
  }

  public async put<T>(
    store: string,
    value: T,
    key?: IDBValidKey
  ): Promise<IDBValidKey | undefined> {
    try {
      const objectStore = this.requireStore(store, 'readwrite');
      const request =
        key !== undefined
          ? objectStore.put(value, key)
          : objectStore.put(value);
      return await wrapRequest(request);
    } catch (err) {
      return this.handleOpError<IDBValidKey | undefined>(
        'put',
        store,
        err,
        undefined
      );
    }
  }

  public async getAll<T>(store: string): Promise<T[]> {
    try {
      const objectStore = this.requireStore(store, 'readonly');
      return await wrapRequest<T[]>(objectStore.getAll() as IDBRequest<T[]>);
    } catch (err) {
      return this.handleOpError<T[]>('getAll', store, err, []);
    }
  }

  public async delete(store: string, key: IDBValidKey): Promise<void> {
    try {
      const objectStore = this.requireStore(store, 'readwrite');
      await wrapRequest(objectStore.delete(key));
    } catch (err) {
      this.handleOpError<void>('delete', store, err, undefined);
    }
  }

  public async count(store: string): Promise<number> {
    try {
      const objectStore = this.requireStore(store, 'readonly');
      return await wrapRequest<number>(objectStore.count());
    } catch (err) {
      return this.handleOpError<number>('count', store, err, 0);
    }
  }

  public async clear(store: string): Promise<void> {
    try {
      const objectStore = this.requireStore(store, 'readwrite');
      await wrapRequest(objectStore.clear());
    } catch (err) {
      this.handleOpError<void>('clear', store, err, undefined);
    }
  }

  /**
   * Escape-Hatch: Raw-Zugriff auf einen ObjectStore innerhalb einer
   * abgeschlossenen Transaction (für Cursor, Index-Queries, Bulk-Ops).
   * `fn` erhält den frischen IDBObjectStore; aufgelöst wird mit deren
   * Rückgabe, sobald die Transaction completed ist. Fehler (aus fn oder aus
   * der Transaction) werden IMMER geworfen — auch bei bestEffort, da der
   * Aufrufer hier bewusst Low-Level-Kontrolle übernommen hat.
   */
  public async withStore<T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (objectStore: IDBObjectStore) => T | Promise<T>
  ): Promise<T> {
    return this.withTransaction([store], mode, tx => fn(tx.objectStore(store)));
  }

  /**
   * Multi-Store-Variante des Escape-Hatch: rohe IDBTransaction über mehrere
   * Stores (Atomizität über Store-Grenzen, z.B. DM saveMessage über
   * messages + conversations). `fn` erhält die Transaction; aufgelöst wird,
   * sobald die Transaction completed ist.
   */
  public async withTransaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => T | Promise<T>
  ): Promise<T> {
    const tx = this.requireTransaction(stores, mode);
    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* already aborted */
      }
      diagLog('system', 'NoorDB: withTransaction callback failed', {
        db: this.name,
        stores: stores.join('+'),
        error: String(err),
      });
      throw err;
    }
    await completeTransaction(tx, this.name, stores.join('+'));
    return result;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private requireDb(): IDBDatabase {
    if (this.closed || !this.rawDb) {
      throw new InvalidStateError(
        `NoorDB: connection "${this.name}" is closed (versionchange or close())`
      );
    }
    return this.rawDb;
  }

  private requireTransaction(
    stores: string[],
    mode: IDBTransactionMode
  ): IDBTransaction {
    const db = this.requireDb();
    for (const store of stores) {
      if (!db.objectStoreNames.contains(store)) {
        throw new InvalidStateError(
          `NoorDB: store "${store}" does not exist in "${this.name}"`
        );
      }
    }
    return db.transaction(stores, mode);
  }

  private requireStore(
    store: string,
    mode: IDBTransactionMode
  ): IDBObjectStore {
    return this.requireTransaction([store], mode).objectStore(store);
  }

  private handleOpError<T>(
    op: string,
    store: string,
    err: unknown,
    fallback: T
  ): T {
    diagLog('system', 'NoorDB: operation failed', {
      db: this.name,
      store,
      op,
      bestEffort: this.bestEffort,
      error: String(err),
    });
    if (this.bestEffort) return fallback;
    throw err;
  }
}

/**
 * Native DOMException('...', 'InvalidStateError') ist in Node-Test-Umgebung
 * nicht universal verfügbar — eigene schlanke Variante mit gleichem Namen
 * der Message nach (Caller prüfen üblicherweise nur die Message / catch-all).
 */
class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('NoorDB: request failed'));
  });
}

function completeTransaction(
  tx: IDBTransaction,
  dbName: string,
  store: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => {
      diagLog('system', 'NoorDB: transaction aborted', {
        db: dbName,
        store,
        error: String(tx.error),
      });
      reject(tx.error ?? new Error('NoorDB: transaction aborted'));
    };
  });
}

function removeFromRegistry(database: NoorDatabase): void {
  for (const connection of registry) {
    if (connection.database === database) {
      registry.delete(connection);
      return;
    }
  }
}

/**
 * Alle als perAccount registrierten Verbindungen schließen (Account-Wechsel,
 * Logout). Globale DBs bleiben offen (Geräte-Keys etc. sind accountfrei).
 * IDBDatabase.close() ist synchron — kein Await nötig.
 */
export function closeAllPerAccountDatabases(): void {
  let closed = 0;
  for (const connection of [...registry]) {
    if (!connection.perAccount) continue;
    connection.database.close();
    closed++;
  }
  if (closed > 0) {
    diagLog('system', 'NoorDB: closed per-account connections', {
      count: closed,
    });
  }
}

/** Offene Verbindungen auflisten (Diagnose/Tests). */
export function listOpenDatabases(): Array<{
  name: string;
  perAccount: boolean;
  open: boolean;
}> {
  return [...registry].map(c => ({
    name: c.name,
    perAccount: c.perAccount,
    open: c.database.isOpen,
  }));
}
