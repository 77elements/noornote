/**
 * NoteTakingSyncService - NIP-78 (kind 30078) relay sync for Note taking.
 *
 * One replaceable event PER note (`d` = `noornote-note-taking:<uuid>`), content =
 * NIP-44 ciphertext (via NoteTakingService). Deletion publishes a `deleted:true`
 * tombstone payload under the SAME d-tag → the relay replaces the old event,
 * physically removing the note's content. Merge is per-note last-write-wins.
 *
 * @service NoteTakingSyncService
 * @used-by runtime, NoteTakingView
 */

import { NostrTransport } from '../../services/transport/NostrTransport';
import { AuthService } from '../../services/AuthService';
import { OutboundRelaysOrchestrator } from '../../services/orchestration/OutboundRelaysOrchestrator';
import { diagLog } from '../../services/DiagnosticLogger';
import { NoteTakingService } from './NoteTakingService';
import type { NoteRecord } from './NoteTakingStore';

const NIP78_KIND = 30078;
const NOTE_TAKING_LABEL = 'noornote-note-taking';

export class NoteTakingSyncService {
  private static instance: NoteTakingSyncService;
  private readonly transport: NostrTransport;
  private readonly auth: AuthService;
  private readonly service: NoteTakingService;
  private isSyncing = false;
  private started = false;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.auth = AuthService.getInstance();
    this.service = NoteTakingService.getInstance();
  }

  public static getInstance(): NoteTakingSyncService {
    if (!NoteTakingSyncService.instance) {
      NoteTakingSyncService.instance = new NoteTakingSyncService();
    }
    return NoteTakingSyncService.instance;
  }

  /** Hook into local changes (publish-on-change) + run the initial sync. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.service.onChange((record) => { void this.publishRecord(record); });
    await this.syncAll();
  }

  /**
   * Pull remote notes (merge) then push all local dirty notes. Returns true if
   * any local state changed (so the board can reload). Re-entrancy guarded.
   */
  public async syncAll(): Promise<boolean> {
    if (this.isSyncing) return false;
    const user = this.auth.getCurrentUser();
    if (!user) return false;

    this.isSyncing = true;
    let changed = false;
    try {
      const relays = await OutboundRelaysOrchestrator.getInstance().getCombinedRelays([user.pubkey], true);
      if (relays.length > 0) {
        // Fetch all our kind:30078 (don't depend on relays indexing the `l` tag);
        // filter to note-taking notes client-side via the d-tag prefix.
        const events = await this.transport.fetch(
          relays,
          [{ kinds: [NIP78_KIND], authors: [user.pubkey] }],
          8000,
          false,
          'NoteTakingSync'
        );
        let noteEvents = 0;
        for (const ev of events) {
          const dTag = ev?.tags?.find((t) => t[0] === 'd')?.[1];
          if (!dTag || !dTag.startsWith(`${NOTE_TAKING_LABEL}:`) || !ev.content) continue;
          noteEvents++;
          const payload = await this.service.decryptPayload(ev.content);
          if (!payload || typeof payload.id !== 'string') continue;
          if (await this.service.applyRemote(payload)) changed = true;
        }
        diagLog('system', 'note-taking: synced from relays', { total: events.length, notes: noteEvents });
      }

      // Push everything still pending.
      const dirty = await this.service.listDirty();
      for (const record of dirty) {
        await this.publishRecord(record);
      }
    } catch (error) {
      diagLog('system', 'note-taking: syncAll failed', { error: String(error) });
    } finally {
      this.isSyncing = false;
    }
    return changed;
  }

  /** Publish (or tombstone-replace) a single note. Best-effort; keeps it dirty on failure. */
  public async publishRecord(record: NoteRecord): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    try {
      const content = await this.service.encryptPayload(this.service.toPayload(record));
      const unsigned = {
        kind: NIP78_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', `${NOTE_TAKING_LABEL}:${record.id}`],
          ['l', NOTE_TAKING_LABEL],
          ['alt', 'Encrypted NoorNote note'],
        ],
        content,
        pubkey: user.pubkey,
      };

      const signed = await this.auth.signEvent(unsigned);
      if (!signed) return;

      await this.transport.publishContent(signed);
      await this.service.markPublished(record);
      diagLog('system', 'note-taking: note published', { id: record.id.slice(0, 8), deleted: !!record.deleted });
    } catch (error) {
      diagLog('system', 'note-taking: publish failed (stays dirty)', { id: record.id.slice(0, 8), error: String(error) });
    }
  }

  public destroy(): void {
    this.service.onChange(null);
    this.started = false;
    NoteTakingSyncService.instance = undefined as unknown as NoteTakingSyncService;
  }
}
