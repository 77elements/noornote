/**
 * KeepSyncService - NIP-78 (kind 30078) relay sync for Nostr Keep.
 *
 * One replaceable event PER note (`d` = `noornote-keep:<uuid>`), content =
 * NIP-44 ciphertext (via KeepService). Deletion publishes a `deleted:true`
 * tombstone payload under the SAME d-tag → the relay replaces the old event,
 * physically removing the note's content. Merge is per-note last-write-wins.
 *
 * @service KeepSyncService
 * @used-by runtime, NostrKeepView
 */

import { NostrTransport } from '../../services/transport/NostrTransport';
import { AuthService } from '../../services/AuthService';
import { OutboundRelaysOrchestrator } from '../../services/orchestration/OutboundRelaysOrchestrator';
import { diagLog } from '../../services/DiagnosticLogger';
import { KeepService } from './KeepService';
import type { KeepNoteRecord } from './KeepStore';

const NIP78_KIND = 30078;
const KEEP_LABEL = 'noornote-keep';

export class KeepSyncService {
  private static instance: KeepSyncService;
  private readonly transport: NostrTransport;
  private readonly auth: AuthService;
  private readonly keep: KeepService;
  private isSyncing = false;
  private started = false;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.auth = AuthService.getInstance();
    this.keep = KeepService.getInstance();
  }

  public static getInstance(): KeepSyncService {
    if (!KeepSyncService.instance) {
      KeepSyncService.instance = new KeepSyncService();
    }
    return KeepSyncService.instance;
  }

  /** Hook into local changes (publish-on-change) + run the initial sync. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.keep.onChange((record) => { void this.publishRecord(record); });
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
        // filter to Keep notes client-side via the d-tag prefix.
        const events = await this.transport.fetch(
          relays,
          [{ kinds: [NIP78_KIND], authors: [user.pubkey] }],
          8000,
          false,
          'KeepSync'
        );
        let keepEvents = 0;
        for (const ev of events) {
          const dTag = ev?.tags?.find((t) => t[0] === 'd')?.[1];
          if (!dTag || !dTag.startsWith(`${KEEP_LABEL}:`) || !ev.content) continue;
          keepEvents++;
          const payload = await this.keep.decryptPayload(ev.content);
          if (!payload || typeof payload.id !== 'string') continue;
          if (await this.keep.applyRemote(payload)) changed = true;
        }
        diagLog('system', 'keep: synced from relays', { total: events.length, keep: keepEvents });
      }

      // Push everything still pending.
      const dirty = await this.keep.listDirty();
      for (const record of dirty) {
        await this.publishRecord(record);
      }
    } catch (error) {
      diagLog('system', 'keep: syncAll failed', { error: String(error) });
    } finally {
      this.isSyncing = false;
    }
    return changed;
  }

  /** Publish (or tombstone-replace) a single note. Best-effort; keeps it dirty on failure. */
  public async publishRecord(record: KeepNoteRecord): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    try {
      const content = await this.keep.encryptPayload(this.keep.toPayload(record));
      const unsigned = {
        kind: NIP78_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', `${KEEP_LABEL}:${record.id}`],
          ['l', KEEP_LABEL],
          ['alt', 'Encrypted NoorNote note'],
        ],
        content,
        pubkey: user.pubkey,
      };

      const signed = await this.auth.signEvent(unsigned);
      if (!signed) return;

      await this.transport.publishContent(signed);
      await this.keep.markPublished(record);
      diagLog('system', 'keep: note published', { id: record.id.slice(0, 8), deleted: !!record.deleted });
    } catch (error) {
      diagLog('system', 'keep: publish failed (stays dirty)', { id: record.id.slice(0, 8), error: String(error) });
    }
  }

  public destroy(): void {
    this.keep.onChange(null);
    this.started = false;
    KeepSyncService.instance = undefined as unknown as KeepSyncService;
  }
}
