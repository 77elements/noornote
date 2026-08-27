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
import { openDb, type NoorDatabase } from './persistence/NoorDB';

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
  /**
   * When true, this job emits NO System Log progress (the 2 DeleteService lines
   * are suppressed). Used by the Bulk Delete addon, which shows progress on its
   * own page instead. Persisted so a resumed silent job stays silent.
   */
  silent?: boolean;
}

const DB_NAME = 'noornote_delete_broadcast';
const DB_VERSION = 1;
const JOBS_STORE = 'jobs';

export class DeleteBroadcastStore {
  private static instance: DeleteBroadcastStore;
  private db: NoorDatabase | null = null;
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

  /** Open the global database (idempotent). Rejects on open failure like before. */
  public async init(): Promise<void> {
    if (this.db?.isOpen) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = openDb(DB_NAME, {
      version: DB_VERSION,
      stores: [{ name: JOBS_STORE, keyPath: 'id' }],
    })
      .then(db => {
        this.db = db;
      })
      .catch(error => {
        this.systemLogger.error(
          'DeleteBroadcast',
          'Failed to open IndexedDB:',
          error
        );
        throw error;
      })
      .finally(() => {
        this.initPromise = null;
      });

    return this.initPromise;
  }

  /** Insert or update a job */
  public async putJob(job: BroadcastJob): Promise<void> {
    await this.init();
    if (!this.db?.isOpen) return;
    await this.db.put(JOBS_STORE, job);
  }

  /** Get all stored jobs */
  public async getAllJobs(): Promise<BroadcastJob[]> {
    await this.init();
    if (!this.db?.isOpen) return [];
    return this.db.getAll<BroadcastJob>(JOBS_STORE);
  }

  /** Delete a job by id (called once fully delivered or expired) */
  public async deleteJob(id: string): Promise<void> {
    await this.init();
    if (!this.db?.isOpen) return;
    await this.db.delete(JOBS_STORE, id);
  }
}
