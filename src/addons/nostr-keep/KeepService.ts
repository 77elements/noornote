/**
 * KeepService - Nostr Keep note management + NIP-44 self-encryption.
 *
 * Owns local CRUD (via KeepStore) and the crypto used by KeepSyncService.
 * Notes are NIP-44-encrypted to the user's OWN pubkey (auth-method-agnostic,
 * same pattern as PetnameService). NO NIP-04 - if the signer can't do NIP-44,
 * Keep is unavailable (mirrors DMService's bunker guard).
 *
 * @service KeepService
 * @used-by NostrKeepView, KeepSyncService, runtime
 */

import { AuthService } from '../../services/AuthService';
import { diagLog } from '../../services/DiagnosticLogger';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { KeepStore, type KeepNotePayload, type KeepNoteRecord } from './KeepStore';

const PAYLOAD_VERSION = 1;

/** uuid → deletion timestamp (sec). Blocks resurrection of locally-deleted notes. */
export type KeepTombstones = Record<string, number>;

export class KeepService {
  private static instance: KeepService;
  private readonly auth: AuthService;
  private readonly store: KeepStore;
  /** Set by KeepSyncService.start() - fired after every local note change. */
  private changeListener: ((record: KeepNoteRecord) => void) | null = null;

  private constructor() {
    this.auth = AuthService.getInstance();
    this.store = KeepStore.getInstance();
  }

  public static getInstance(): KeepService {
    if (!KeepService.instance) {
      KeepService.instance = new KeepService();
    }
    return KeepService.instance;
  }

  /** Open the per-user store for the current user. Call on login / board mount. */
  public async init(): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (user) await this.store.init(user.pubkey);
  }

  /** True if the active signer can do NIP-44 (bunker URL cannot → Keep unavailable). */
  public isAvailable(): boolean {
    return !this.auth.isBunkerAuth() && !!this.auth.getCurrentUser();
  }

  /** Register the post-change hook (KeepSyncService publishes from here). */
  public onChange(listener: ((record: KeepNoteRecord) => void) | null): void {
    this.changeListener = listener;
  }

  private notifyChange(record: KeepNoteRecord): void {
    try {
      this.changeListener?.(record);
    } catch (error) {
      diagLog('system', 'keep: change listener threw', { error: String(error) });
    }
  }

  // ── Local CRUD ─────────────────────────────────────────────────────────────

  /** Live (non-deleted) notes for the board. */
  public async listNotes(): Promise<KeepNoteRecord[]> {
    const all = await this.store.getAll();
    return all.filter((n) => !n.deleted);
  }

  /** All dirty records (incl. pending tombstones) - for KeepSyncService. */
  public async listDirty(): Promise<KeepNoteRecord[]> {
    return this.store.getDirty();
  }

  public get storeRef(): KeepStore {
    return this.store;
  }

  public async getNote(id: string): Promise<KeepNoteRecord | null> {
    return this.store.get(id);
  }

  /** Create a new note from a partial payload; assigns id + timestamps. */
  public async createNote(partial: Partial<KeepNotePayload> = {}): Promise<KeepNoteRecord> {
    const now = Math.floor(Date.now() / 1000);
    const record: KeepNoteRecord = {
      v: PAYLOAD_VERSION,
      id: crypto.randomUUID(),
      title: '',
      body: '',
      checklist: [],
      labels: [],
      color: 'default',
      pinned: false,
      archived: false,
      reminderAt: 0,
      attachments: [],
      createdAt: now,
      updatedAt: now,
      ...partial,
      dirty: true,
    };
    await this.store.put(record);
    diagLog('system', 'keep: note created', { id: record.id.slice(0, 8) });
    this.notifyChange(record);
    return record;
  }

  /** Patch an existing note; bumps updatedAt + marks dirty. */
  public async updateNote(
    id: string,
    patch: Partial<KeepNotePayload>
  ): Promise<KeepNoteRecord | null> {
    const existing = await this.store.get(id);
    if (!existing) return null;
    const updated: KeepNoteRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Math.floor(Date.now() / 1000),
      dirty: true,
    };
    await this.store.put(updated);
    this.notifyChange(updated);
    return updated;
  }

  /**
   * Delete a note: turn it into a tombstone (content emptied, `deleted:true`)
   * and record a local tombstone. KeepSyncService publishes the tombstone, which
   * REPLACES the note's own d-tag event → its content is physically removed from
   * relays (not merely flagged). The record stays local+dirty until published.
   */
  public async deleteNote(id: string): Promise<void> {
    const existing = await this.store.get(id);
    if (!existing) return;

    const now = Math.floor(Date.now() / 1000);
    const tombstone: KeepNoteRecord = {
      v: existing.v,
      id: existing.id,
      title: '',
      body: '',
      checklist: [],
      labels: [],
      color: 'default',
      pinned: false,
      archived: false,
      reminderAt: 0,
      attachments: [],
      createdAt: existing.createdAt,
      updatedAt: now,
      deleted: true,
      dirty: true,
    };
    await this.store.put(tombstone);
    this.addTombstone(id, now);
    diagLog('system', 'keep: note deleted (tombstoned)', { id: id.slice(0, 8) });
    this.notifyChange(tombstone);
  }

  // ── Tombstone set (resurrection guard) ─────────────────────────────────────

  public getTombstones(): KeepTombstones {
    return PerAccountLocalStorage.getInstance().get<KeepTombstones>(StorageKeys.KEEP_TOMBSTONES, {});
  }

  public addTombstone(id: string, ts: number): void {
    const map = this.getTombstones();
    map[id] = ts;
    PerAccountLocalStorage.getInstance().set(StorageKeys.KEEP_TOMBSTONES, map);
  }

  public isTombstoned(id: string, updatedAt: number): boolean {
    const ts = this.getTombstones()[id];
    return ts !== undefined && updatedAt <= ts;
  }

  // ── Sync merge helpers (used by KeepSyncService) ───────────────────────────

  /** After a successful publish: clear dirty, or drop the local tombstone record. */
  public async markPublished(record: KeepNoteRecord): Promise<void> {
    if (record.deleted) {
      // Tombstone is on relays now; drop the local record (KEEP_TOMBSTONES guards resurrection).
      await this.store.delete(record.id);
    } else {
      await this.store.put({ ...record, dirty: false });
    }
  }

  /**
   * Merge a decrypted remote payload into the local store. Rules:
   * - remote tombstone → record tombstone + remove local note,
   * - locally tombstoned & remote not newer → ignore (no resurrection),
   * - otherwise last-write-wins by updatedAt.
   * Returns true if local state changed.
   */
  public async applyRemote(payload: KeepNotePayload): Promise<boolean> {
    if (payload.deleted) {
      this.addTombstone(payload.id, payload.updatedAt);
      const local = await this.store.get(payload.id);
      if (local) {
        await this.store.delete(payload.id);
        return true;
      }
      return false;
    }

    if (this.isTombstoned(payload.id, payload.updatedAt)) return false;

    const local = await this.store.get(payload.id);
    if (local && local.updatedAt >= payload.updatedAt) return false;

    await this.store.put({ ...payload, dirty: false });
    return true;
  }

  // ── Crypto (used by KeepSyncService) ───────────────────────────────────────

  /** Strip local-only metadata, leaving just the publishable payload. */
  public toPayload(record: KeepNoteRecord): KeepNotePayload {
    const { dirty: _dirty, ...payload } = record;
    return payload;
  }

  /**
   * NIP-44-encrypt a note payload to the user's own pubkey, with an integrity
   * guard: a silently-failed encrypt that returned plaintext would leak the
   * note to relays - so we refuse to emit anything that still looks like JSON.
   */
  public async encryptPayload(payload: KeepNotePayload): Promise<string> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Keep: no user');

    const plaintext = JSON.stringify(payload);
    const ciphertext = await this.auth.nip44Encrypt(plaintext, user.pubkey);

    // Integrity check: NIP-44 output is version-prefixed base64 - it must not be
    // the plaintext JSON. These markers can only appear if encryption failed.
    if (
      !ciphertext ||
      ciphertext === plaintext ||
      ciphertext.trimStart().startsWith('{') ||
      ciphertext.includes('"id":')
    ) {
      diagLog('system', 'keep: encryption integrity check FAILED', { id: payload.id.slice(0, 8) });
      throw new Error('Keep: encryption integrity check failed (output looks like plaintext)');
    }

    return ciphertext;
  }

  /** Decrypt a stored ciphertext back into a payload (null on failure). */
  public async decryptPayload(ciphertext: string): Promise<KeepNotePayload | null> {
    const user = this.auth.getCurrentUser();
    if (!user) return null;
    try {
      const plaintext = await this.auth.nip44Decrypt(ciphertext, user.pubkey);
      if (!plaintext) return null;
      const parsed = JSON.parse(plaintext) as KeepNotePayload;
      if (!parsed || typeof parsed.id !== 'string') return null;
      return parsed;
    } catch (error) {
      diagLog('system', 'keep: decrypt failed', { error: String(error) });
      return null;
    }
  }

  /** Tear down: close the store and drop the singleton. */
  public destroy(): void {
    this.changeListener = null;
    this.store.close();
    KeepService.instance = undefined as unknown as KeepService;
  }
}
