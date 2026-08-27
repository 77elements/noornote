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
import { openDb, type NoorDatabase } from '../../services/persistence/NoorDB';

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
  /** nostr-keep interop: soft "trash" flag. We never set it, but preserve it on
   *  round-trip and hide trashed notes from the board. */
  trash?: boolean;
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
  private db: NoorDatabase | null = null;
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

  /** Open (or switch to) the per-user database. Rejects on open failure like before. */
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
      this.systemLogger.warn(
        'NoteTakingStore',
        'init() called without pubkey and no current user'
      );
      return;
    }

    if (this.db?.isOpen) return;
    if (this.initPromise) return this.initPromise;

    const dbName = DB_NAME_PREFIX + pubkey;
    const openPromise = openDb(dbName, {
      version: DB_VERSION,
      stores: [
        {
          name: NOTES_STORE,
          keyPath: 'id',
          indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
        },
      ],
    })
      .then(db => {
        this.db = db;
      })
      .catch(error => {
        this.systemLogger.error(
          'NoteTakingStore',
          'Failed to open IndexedDB:',
          error
        );
        throw error;
      })
      // In-Flight-Cache leeren: Retry nach Failed-Open, sauberes Re-Open nach
      // versionchange-Auto-Close.
      .finally(() => {
        this.initPromise = null;
      });
    this.initPromise = openPromise;
    return openPromise;
  }

  /** Insert or replace a note. */
  public async put(record: NoteRecord): Promise<void> {
    await this.init();
    if (!this.db?.isOpen) return;
    await this.db.put(NOTES_STORE, record);
  }

  /** Get a single note by id. */
  public async get(id: string): Promise<NoteRecord | null> {
    await this.init();
    if (!this.db?.isOpen) return null;
    return (await this.db.get<NoteRecord>(NOTES_STORE, id)) ?? null;
  }

  /** All notes, newest-updated first. */
  public async getAll(): Promise<NoteRecord[]> {
    await this.init();
    if (!this.db?.isOpen) return [];
    const notes = await this.db.getAll<NoteRecord>(NOTES_STORE);
    notes.sort((a, b) => b.updatedAt - a.updatedAt);
    return notes;
  }

  /** Notes that still need to be pushed to relays. */
  public async getDirty(): Promise<NoteRecord[]> {
    const all = await this.getAll();
    return all.filter(n => n.dirty);
  }

  /** Delete a note by id. */
  public async delete(id: string): Promise<void> {
    await this.init();
    if (!this.db?.isOpen) return;
    await this.db.delete(NOTES_STORE, id);
  }

  /** Wipe all notes for the current user. */
  public async clear(): Promise<void> {
    if (!this.db?.isOpen) return;
    await this.db.clear(NOTES_STORE);
  }

  /** Close the DB connection (logout / addon teardown). Does NOT delete data. */
  public close(): void {
    this.db?.close();
    this.db = null;
    this.initPromise = null;
    this.currentUserPubkey = null;
  }
}
