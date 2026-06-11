/**
 * DeleteBroadcastStore - Persistent queue for NIP-09 deletion broadcasts
 *
 * Global (NOT per-account) IndexedDB store. A kind:5 deletion event is already
 * signed and self-contained, so re-broadcasting needs no signer. Storing the
 * queue globally lets the broadcast finish on the next app launch regardless of
 * which account is logged in (or even if the user never logs back into the
 * account that issued the deletion).
 *
 * @service DeleteBroadcastStore
 * @purpose Crash-resilient, resumable delete-broadcast jobs
 * @used-by BroadcastDeleteService
 */

import { SystemLogger } from './SystemLogger';

/** Per-relay delivery state within a broadcast job */
export interface RelayDeliveryState {
  /** pending = no definitive answer yet (retry); sent = relay answered OK true; rejected = OK false (final, no retry) */
  status: 'pending' | 'sent' | 'rejected';
  /** Number of send attempts so far */
  attempts: number;
  /** Epoch ms: earliest time this relay may be retried (backoff) */
  nextAttemptAt: number;
  /** Last error/notice for diagnostics */
  lastError?: string;
}

/** Minimal signed event shape stored for re-broadcast */
export interface StoredSignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A persisted delete-broadcast job */
export interface BroadcastJob {
  /** Signed kind:5 event id (primary key) */
  id: string;
  /** The signed deletion event to (re-)broadcast */
  event: StoredSignedEvent;
  /** Epoch ms when the job was created */
  createdAt: number;
  /** Epoch ms after which the job is abandoned and pruned (TTL) */
  expiresAt: number;
  /** Per-relay delivery state, keyed by relay URL */
  relays: Record<string, RelayDeliveryState>;
}

const DB_NAME = 'noornote_delete_broadcast';
const DB_VERSION = 1;
const JOBS_STORE = 'jobs';

export class DeleteBroadcastStore {
  private static instance: DeleteBroadcastStore;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private systemLogger: SystemLogger;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): DeleteBroadcastStore {
    if (!DeleteBroadcastStore.instance) {
      DeleteBroadcastStore.instance = new DeleteBroadcastStore();
    }
    return DeleteBroadcastStore.instance;
  }

  /** Open the global database (idempotent) */
  public async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        this.systemLogger.error('DeleteBroadcast', 'Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(JOBS_STORE)) {
          db.createObjectStore(JOBS_STORE, { keyPath: 'id' });
        }
      };
    });

    return this.initPromise;
  }

  /** Insert or update a job */
  public async putJob(job: BroadcastJob): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([JOBS_STORE], 'readwrite');
      tx.objectStore(JOBS_STORE).put(job);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Get all stored jobs */
  public async getAllJobs(): Promise<BroadcastJob[]> {
    await this.init();
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([JOBS_STORE], 'readonly');
      const req = tx.objectStore(JOBS_STORE).getAll();
      req.onsuccess = () => resolve((req.result as BroadcastJob[]) || []);
      req.onerror = () => reject(req.error);
    });
  }

  /** Delete a job by id (called once fully delivered or expired) */
  public async deleteJob(id: string): Promise<void> {
    await this.init();
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([JOBS_STORE], 'readwrite');
      tx.objectStore(JOBS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
