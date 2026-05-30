/**
 * NoteTakingStore - per-user IndexedDB store for Note taking notes.
 *
 * Mirrors DMStore's per-user DB pattern (db `noornote_note_taking_{pubkey}`). Notes are
 * held as PLAINTEXT locally (instant search/render); only ciphertext leaves the
 * device, via NoteTakingSyncService. The `dirty` flag marks notes needing a relay push.
 *
 * @service NoteTakingStore
 * @used-by NoteTakingService
 */

import { SystemLogger } from '../../services/SystemLogger';

export interface NoteChecklistItem {
  text: string;
  checked: boolean;
}

export interface NoteAttachment {
  url: string;
  sha256?: string;
  dim?: string;
  blurhash?: string;
}

/** The encrypted payload - exactly what gets published to relays (kind 30078). */
export interface NotePayload {
  /** Schema version */
  v: number;
  /** UUID - also the kind:30078 d-tag suffix */
  id: string;
  title: string;
  /** Markdown body */
  body: string;
  checklist: NoteChecklistItem[];
  labels: string[];
  /** Palette key (e.g. 'default', 'coral', …) */
  color: string;
  pinned: boolean;
  archived: boolean;
  /** Local reminder time (epoch sec), 0 = none */
  reminderAt: number;
  attachments: NoteAttachment[];
  createdAt: number;
  updatedAt: number;
  /** Tombstone marker: when true, all content fields are emptied (a deleted note). */
  deleted?: boolean;
}

/** Local store record = payload + sync metadata (`dirty` is NOT published). */
export interface NoteRecord extends NotePayload {
  /** Needs a relay push (set on every local edit, cleared after publish). */
  dirty: boolean;
}

const DB_NAME_PREFIX = 'noornote_note_taking_';
const DB_VERSION = 1;
const NOTES_STORE = 'notes';

export class NoteTakingStore {
  private static instance: NoteTakingStore;
  private db: IDBDatabase | null = null;
  private systemLogger: SystemLogger;
  private initPromise: Promise<void> | null = null;
  private currentUserPubkey: string | null = null;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): NoteTakingStore {
    if (!NoteTakingStore.instance) {
      NoteTakingStore.instance = new NoteTakingStore();
    }
    return NoteTakingStore.instance;
  }

  /** Open (or switch to) the per-user database. */
  public async init(userPubkey?: string): Promise<void> {
    if (userPubkey && this.currentUserPubkey !== userPubkey) {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      this.initPromise = null;
      this.currentUserPubkey = userPubkey;
    }

    const pubkey = userPubkey || this.currentUserPubkey;
    if (!pubkey) {
      this.systemLogger.warn('NoteTakingStore', 'init() called without pubkey and no current user');
      return;
    }

    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    const dbName = DB_NAME_PREFIX + pubkey;
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => {
        this.systemLogger.error('NoteTakingStore', 'Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(NOTES_STORE)) {
          const store = db.createObjectStore(NOTES_STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  /** Insert or replace a note. */
  public async put(record: NoteRecord): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(NOTES_STORE, 'readwrite');
      tx.objectStore(NOTES_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Get a single note by id. */
  public async get(id: string): Promise<NoteRecord | null> {
    await this.init();
    if (!this.db) return null;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(NOTES_STORE, 'readonly');
      const request = tx.objectStore(NOTES_STORE).get(id);
      request.onsuccess = () => resolve((request.result as NoteRecord) || null);
      request.onerror = () => reject(request.error);
    });
  }

  /** All notes, newest-updated first. */
  public async getAll(): Promise<NoteRecord[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(NOTES_STORE, 'readonly');
      const request = tx.objectStore(NOTES_STORE).getAll();
      request.onsuccess = () => {
        const notes = (request.result as NoteRecord[]) || [];
        notes.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /** Notes that still need to be pushed to relays. */
  public async getDirty(): Promise<NoteRecord[]> {
    const all = await this.getAll();
    return all.filter((n) => n.dirty);
  }

  /** Delete a note by id. */
  public async delete(id: string): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(NOTES_STORE, 'readwrite');
      tx.objectStore(NOTES_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Wipe all notes for the current user. */
  public async clear(): Promise<void> {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(NOTES_STORE, 'readwrite');
      tx.objectStore(NOTES_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Close the DB connection (logout / addon teardown). Does NOT delete data. */
  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initPromise = null;
    this.currentUserPubkey = null;
  }
}
