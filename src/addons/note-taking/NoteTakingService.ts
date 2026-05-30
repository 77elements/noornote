/**
 * NoteTakingService - Note taking note management + NIP-44 self-encryption.
 *
 * Owns local CRUD (via NoteTakingStore) and the crypto used by NoteTakingSyncService.
 * Notes are NIP-44-encrypted to the user's OWN pubkey (auth-method-agnostic,
 * same pattern as PetnameService). NO NIP-04 - if the signer can't do NIP-44,
 * note-taking is unavailable (mirrors DMService's bunker guard).
 *
 * @service NoteTakingService
 * @used-by NoteTakingView, NoteTakingSyncService, runtime
 */

import { AuthService } from '../../services/AuthService';
import { diagLog } from '../../services/DiagnosticLogger';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { NoteTakingStore, type NotePayload, type NoteRecord } from './NoteTakingStore';

const PAYLOAD_VERSION = 1;

/** uuid → deletion timestamp (sec). Blocks resurrection of locally-deleted notes. */
export type NoteTombstones = Record<string, number>;

export class NoteTakingService {
  private static instance: NoteTakingService;
  private readonly auth: AuthService;
  private readonly store: NoteTakingStore;
  /** Set by NoteTakingSyncService.start() - fired after every local note change. */
  private changeListener: ((record: NoteRecord) => void) | null = null;
  /** Note id to pulse on the next board render (set when opening from a reminder). */
  private pendingHighlightId: string | null = null;

  private constructor() {
    this.auth = AuthService.getInstance();
    this.store = NoteTakingStore.getInstance();
  }

  /** Mark a note to be highlighted (pulsed) on the next board render. */
  public setHighlight(id: string): void {
    this.pendingHighlightId = id;
  }

  /** Read + clear the pending highlight id. */
  public consumeHighlight(): string | null {
    const id = this.pendingHighlightId;
    this.pendingHighlightId = null;
    return id;
  }

  public static getInstance(): NoteTakingService {
    if (!NoteTakingService.instance) {
      NoteTakingService.instance = new NoteTakingService();
    }
    return NoteTakingService.instance;
  }

  /** Open the per-user store for the current user. Call on login / board mount. */
  public async init(): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (user) await this.store.init(user.pubkey);
  }

  /** True if the active signer can do NIP-44 (bunker URL cannot → note-taking unavailable). */
  public isAvailable(): boolean {
    return !this.auth.isBunkerAuth() && !!this.auth.getCurrentUser();
  }

  /** Register the post-change hook (NoteTakingSyncService publishes from here). */
  public onChange(listener: ((record: NoteRecord) => void) | null): void {
    this.changeListener = listener;
  }

  private notifyChange(record: NoteRecord): void {
    try {
      this.changeListener?.(record);
    } catch (error) {
      diagLog('system', 'note-taking: change listener threw', { error: String(error) });
    }
  }

  // ── Local CRUD ─────────────────────────────────────────────────────────────

  /** Live (non-deleted) notes for the board. */
  public async listNotes(): Promise<NoteRecord[]> {
    const all = await this.store.getAll();
    return all.filter((n) => !n.deleted);
  }

  /** All dirty records (incl. pending tombstones) - for NoteTakingSyncService. */
  public async listDirty(): Promise<NoteRecord[]> {
    return this.store.getDirty();
  }

  public get storeRef(): NoteTakingStore {
    return this.store;
  }

  public async getNote(id: string): Promise<NoteRecord | null> {
    return this.store.get(id);
  }

  /** Create a new note from a partial payload; assigns id + timestamps. */
  public async createNote(partial: Partial<NotePayload> = {}): Promise<NoteRecord> {
    const now = Math.floor(Date.now() / 1000);
    const record: NoteRecord = {
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
    diagLog('system', 'note-taking: note created', { id: record.id.slice(0, 8) });
    this.notifyChange(record);
    return record;
  }

  /** Patch an existing note; bumps updatedAt + marks dirty. */
  public async updateNote(
    id: string,
    patch: Partial<NotePayload>
  ): Promise<NoteRecord | null> {
    const existing = await this.store.get(id);
    if (!existing) return null;
    const updated: NoteRecord = {
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
   * and record a local tombstone. NoteTakingSyncService publishes the tombstone, which
   * REPLACES the note's own d-tag event → its content is physically removed from
   * relays (not merely flagged). The record stays local+dirty until published.
   */
  public async deleteNote(id: string): Promise<void> {
    const existing = await this.store.get(id);
    if (!existing) return;

    const now = Math.floor(Date.now() / 1000);
    const tombstone: NoteRecord = {
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
    diagLog('system', 'note-taking: note deleted (tombstoned)', { id: id.slice(0, 8) });
    this.notifyChange(tombstone);
  }

  // ── Tombstone set (resurrection guard) ─────────────────────────────────────

  public getTombstones(): NoteTombstones {
    return PerAccountLocalStorage.getInstance().get<NoteTombstones>(StorageKeys.NOTE_TAKING_TOMBSTONES, {});
  }

  public addTombstone(id: string, ts: number): void {
    const map = this.getTombstones();
    map[id] = ts;
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOTE_TAKING_TOMBSTONES, map);
  }

  public isTombstoned(id: string, updatedAt: number): boolean {
    const ts = this.getTombstones()[id];
    return ts !== undefined && updatedAt <= ts;
  }

  // ── Sync merge helpers (used by NoteTakingSyncService) ───────────────────────────

  /** After a successful publish: clear dirty, or drop the local tombstone record. */
  public async markPublished(record: NoteRecord): Promise<void> {
    if (record.deleted) {
      // Tombstone is on relays now; drop the local record (NOTE_TAKING_TOMBSTONES guards resurrection).
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
  public async applyRemote(payload: NotePayload): Promise<boolean> {
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

  // ── Crypto (used by NoteTakingSyncService) ───────────────────────────────────────

  /** Strip local-only metadata, leaving just the publishable payload. */
  public toPayload(record: NoteRecord): NotePayload {
    const { dirty: _dirty, ...payload } = record;
    return payload;
  }

  /**
   * NIP-44-encrypt a note payload to the user's own pubkey, with an integrity
   * guard: a silently-failed encrypt that returned plaintext would leak the
   * note to relays - so we refuse to emit anything that still looks like JSON.
   */
  public async encryptPayload(payload: NotePayload): Promise<string> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Note taking: no user');

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
      diagLog('system', 'note-taking: encryption integrity check FAILED', { id: payload.id.slice(0, 8) });
      throw new Error('Note taking: encryption integrity check failed (output looks like plaintext)');
    }

    return ciphertext;
  }

  /** Decrypt a stored ciphertext back into a payload (null on failure). */
  public async decryptPayload(ciphertext: string): Promise<NotePayload | null> {
    const user = this.auth.getCurrentUser();
    if (!user) return null;
    try {
      const plaintext = await this.auth.nip44Decrypt(ciphertext, user.pubkey);
      if (!plaintext) return null;
      const raw = JSON.parse(plaintext) as Record<string, unknown>;
      if (!raw || typeof raw.id !== 'string') return null;
      return this.normalizePayload(raw, raw.id);
    } catch (error) {
      diagLog('system', 'note-taking: decrypt failed', { error: String(error) });
      return null;
    }
  }

  /**
   * Coerce a decrypted object into a well-typed payload. Defends the renderer
   * against schema drift / corruption: every field gets a safe default of the
   * right type, so a malformed note can never crash the board or be mistyped.
   */
  private normalizePayload(raw: Record<string, unknown>, id: string): NotePayload {
    const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
    const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const checklist = Array.isArray(raw.checklist)
      ? raw.checklist
          .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
          .map((it) => ({ text: str(it.text), checked: !!it.checked }))
          .filter((it) => it.text.length > 0)
      : [];
    const labels = Array.isArray(raw.labels)
      ? raw.labels.filter((l): l is string => typeof l === 'string')
      : [];
    const attachments = Array.isArray(raw.attachments)
      ? raw.attachments
          .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
          .map((a) => ({ url: str(a.url), sha256: str(a.sha256), dim: str(a.dim), blurhash: str(a.blurhash) }))
      : [];
    return {
      v: num(raw.v, PAYLOAD_VERSION),
      id,
      title: str(raw.title),
      body: str(raw.body),
      checklist,
      labels,
      color: str(raw.color, 'default'),
      pinned: !!raw.pinned,
      archived: !!raw.archived,
      reminderAt: num(raw.reminderAt),
      attachments,
      createdAt: num(raw.createdAt),
      updatedAt: num(raw.updatedAt),
      ...(raw.deleted ? { deleted: true } : {}),
    };
  }

  /** Tear down: close the store and drop the singleton. */
  public destroy(): void {
    this.changeListener = null;
    this.store.close();
    NoteTakingService.instance = undefined as unknown as NoteTakingService;
  }
}
