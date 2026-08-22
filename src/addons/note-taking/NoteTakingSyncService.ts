/**
 * NoteTakingSyncService - NIP-78 (kind 30078) relay sync for Note taking.
 *
 * One replaceable event PER note (`d` = `nostr-keep-note-<uuid>`, the nostr-keep
 * namespace — see docs/features/note-taking-addon.md interop), content = NIP-44
 * ciphertext (via NoteTakingService). Deletion publishes a `deleted:true`
 * tombstone payload under the SAME d-tag → the relay replaces the old event,
 * physically removing the note's content. Merge is per-note last-write-wins.
 * Legacy `noornote-note-taking:<uuid>` events are read and migrated forward.
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
// nostr-keep interop: we read/write keep's exact d-tag namespace.
const KEEP_DTAG_PREFIX = 'nostr-keep-note-';
// Legacy NoorNote namespace (pre-interop). Read-only — migrated forward to KEEP_DTAG_PREFIX.
const LEGACY_DTAG_PREFIX = 'noornote-note-taking:';

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
    this.service.onChange(record => {
      void this.publishRecord(record);
    });
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
      const relays =
        await OutboundRelaysOrchestrator.getInstance().getCombinedRelays(
          [user.pubkey],
          true
        );
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
        const newIds = new Set<string>();
        const legacyIds = new Set<string>();
        for (const ev of events) {
          const dTag = ev?.tags?.find(t => t[0] === 'd')?.[1];
          if (!dTag || !ev.content) continue;
          let id: string;
          if (dTag.startsWith(KEEP_DTAG_PREFIX)) {
            id = dTag.slice(KEEP_DTAG_PREFIX.length);
            newIds.add(id);
          } else if (dTag.startsWith(LEGACY_DTAG_PREFIX)) {
            id = dTag.slice(LEGACY_DTAG_PREFIX.length);
            legacyIds.add(id);
          } else {
            continue;
          }
          if (!id) continue;
          const payload = await this.service.decryptPayload(ev.content, id);
          if (!payload) continue;
          if (await this.service.applyRemote(payload)) changed = true;
        }
        // Migration: a note that exists ONLY under the legacy d-tag gets re-published
        // under the keep d-tag (markForRepublish keeps updatedAt → LWW preserved). We
        // deliberately do NOT tombstone the legacy event: an un-upgraded second device
        // must keep seeing it, and the local tombstone set already blocks resurrection.
        for (const id of legacyIds) {
          if (!newIds.has(id)) {
            await this.service.markForRepublish(id);
            changed = true;
          }
        }
        diagLog('system', 'note-taking: synced from relays', {
          total: events.length,
          new: newIds.size,
          legacy: legacyIds.size,
        });
      }

      // Push everything still pending.
      const dirty = await this.service.listDirty();
      for (const record of dirty) {
        await this.publishRecord(record);
      }
    } catch (error) {
      diagLog('system', 'note-taking: syncAll failed', {
        error: String(error),
      });
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
      const content = await this.service.encryptPayload(
        this.service.toPayload(record)
      );
      const unsigned = {
        kind: NIP78_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', `${KEEP_DTAG_PREFIX}${record.id}`],
          ['alt', 'Encrypted note'],
        ],
        content,
        pubkey: user.pubkey,
      };

      const signed = await this.auth.signEvent(unsigned);
      if (!signed) return;

      await this.transport.publishContent(signed);
      await this.service.markPublished(record);
      diagLog('system', 'note-taking: note published', {
        id: record.id.slice(0, 8),
        deleted: !!record.deleted,
      });
    } catch (error) {
      diagLog('system', 'note-taking: publish failed (stays dirty)', {
        id: record.id.slice(0, 8),
        error: String(error),
      });
    }
  }

  public destroy(): void {
    this.service.onChange(null);
    this.started = false;
    NoteTakingSyncService.instance =
      undefined as unknown as NoteTakingSyncService;
  }
}
