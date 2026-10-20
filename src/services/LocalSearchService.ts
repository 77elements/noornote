/**
 * LocalSearchService — sovereign full-text search over content NoorNote
 * already holds locally (P2 of the 2026-09 sovereignty roadmap). No relay
 * round-trip, no third-party search provider: searching must not tell the
 * network what you are looking for.
 *
 * Two in-memory MiniSearch indexes:
 *  - Notes: fed by the `note:cached` stream (every event that enters the
 *    NoteService LRU — timelines, SNV, quotes, relay browser) plus the LRU
 *    snapshot present at construction time. Session-scoped by design.
 *  - DMs: built lazily on the first DM search from DMStore's decrypted
 *    plaintext, kept fresh via `dm:new-message`. Per-account by construction
 *    (DMStore is per-account) and wiped on login/logout.
 *
 * Both indexes live in memory only — logout wipes them, nothing persists.
 * See docs/todos/local-search.md.
 */

import MiniSearch from 'minisearch';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NoteService } from './NoteService';
import { DMStore, type DMMessage } from './dm/DMStore';
import { TypedEventBus } from '../core/TypedEventBus';
import { diagLog } from './DiagnosticLogger';

/** Kinds whose content is worth indexing (text-bearing originals only — no
 * reposts/reactions/envelopes, their content duplicates other events). */
const NOTE_SEARCHABLE_KINDS = new Set([1, 20, 21, 22, 1068, 30023]);

/** Cap for the DM index (most recent messages win) — history can be huge. */
const MAX_DM_DOCS = 5000;

interface NoteDoc {
  id: string;
  kind: number;
  pubkey: string;
  createdAt: number;
  /** Note text (or article markdown). */
  content: string;
  /** Article title (kind 30023) — boosted above content. */
  title?: string;
}

interface DmDoc {
  id: string;
  pubkey: string;
  conversationWith: string;
  createdAt: number;
  isMine: boolean;
  content: string;
  subject?: string;
}

export interface LocalSearchResults {
  notes: NostrEvent[];
  dms: DMMessage[];
}

export class LocalSearchService {
  private static instance: LocalSearchService | null = null;

  public static getInstance(): LocalSearchService {
    LocalSearchService.instance ??= new LocalSearchService();
    return LocalSearchService.instance;
  }

  private noteIndex: MiniSearch<NoteDoc>;
  private dmIndex: MiniSearch<DmDoc> | null = null;
  private dmIndexBuilding: Promise<void> | null = null;
  /** Indexed ids — events/messages are immutable, so first-wins, no replaces. */
  private indexedNoteIds = new Set<string>();
  private indexedDmIds = new Set<string>();
  private eventBusSubscriptionIds: string[] = [];

  private constructor() {
    this.noteIndex = new MiniSearch<NoteDoc>({
      fields: ['content', 'title'],
      storeFields: ['kind', 'pubkey', 'createdAt'],
    });

    // Seed from whatever the NoteService LRU already holds, then keep the
    // index fresh off the same stream.
    for (const event of NoteService.getInstance().getAllCachedEvents()) {
      this.indexNote(event);
    }
    const bus = TypedEventBus.getInstance();
    this.eventBusSubscriptionIds.push(
      bus.on('note:cached', ({ eventId }) => {
        const event = NoteService.getInstance().getCachedNote(eventId);
        if (event) this.indexNote(event);
      })
    );
    this.eventBusSubscriptionIds.push(
      bus.on('dm:new-message', ({ message }) => {
        if (this.indexedDmIds.has(message.id)) return;
        this.dmIndex?.add(this.dmDocFrom(message));
        this.indexedDmIds.add(message.id);
      })
    );
    // Privacy: the DM plaintext index never survives an account boundary.
    this.eventBusSubscriptionIds.push(
      bus.on('user:logout', () => this.clear())
    );
    this.eventBusSubscriptionIds.push(bus.on('user:login', () => this.clear()));
    diagLog('system', 'local_search_init', {});
  }

  /** Wipe both indexes (logout / account switch — DM plaintext must not leak). */
  public clear(): void {
    this.noteIndex = new MiniSearch<NoteDoc>({
      fields: ['content', 'title'],
      storeFields: ['kind', 'pubkey', 'createdAt'],
    });
    this.dmIndex = null;
    this.dmIndexBuilding = null;
    this.indexedNoteIds.clear();
    this.indexedDmIds.clear();
    // Re-seed the note index — the NoteService LRU survives the bus event
    // and its content is public anyway.
    for (const event of NoteService.getInstance().getAllCachedEvents()) {
      this.indexNote(event);
    }
  }

  public destroy(): void {
    const bus = TypedEventBus.getInstance();
    for (const id of this.eventBusSubscriptionIds) bus.off(id);
    this.eventBusSubscriptionIds = [];
    this.noteIndex.removeAll();
    this.dmIndex = null;
    this.dmIndexBuilding = null;
    this.indexedNoteIds.clear();
    this.indexedDmIds.clear();
    LocalSearchService.instance = null;
  }

  /**
   * Search local notes (MiniSearch: prefix matching, no fuzzy — a private
   * search only surfaces content containing the query term; title boosted
   * above content). Results are resolved back to full events via the
   * NoteService (relay fallback for evicted entries) and keep MiniSearch
   * relevance order.
   */
  public async searchNotes(
    query: string,
    limit: number = 25
  ): Promise<NostrEvent[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const hits = this.noteIndex.search(trimmed, {
      prefix: true,
      // No fuzzy matching: a private search must only surface content that
      // actually contains the query term (prefix matches included).
      boost: { title: 2 },
    });

    const noteService = NoteService.getInstance();
    const events: NostrEvent[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const event = await noteService.getNote(hit.id as string);
      const id = event?.id ?? '';
      if (event && id && !seen.has(id)) {
        seen.add(id);
        events.push(event);
        if (events.length >= limit) break;
      }
    }
    return events;
  }

  /**
   * Search decrypted DMs (per-account plaintext from DMStore). The index is
   * built lazily on first use; subsequent searches reuse it.
   */
  public async searchDMs(
    query: string,
    limit: number = 25
  ): Promise<DMMessage[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    await this.ensureDmIndex();
    if (!this.dmIndex) return [];

    const hits = this.dmIndex.search(trimmed, {
      prefix: true,
      // No fuzzy matching — see searchNotes.
      boost: { subject: 2 },
    });

    // MiniSearch hits carry the stored fields — resolve each hit back to the
    // exact message by id (≤ limit single-key IDB lookups).
    const dmStore = DMStore.getInstance();
    const results: DMMessage[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const doc = hit as unknown as DmDoc;
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      const message = await dmStore.getMessageById(doc.id);
      if (message) {
        results.push(message);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /** One combined search (notes + DMs) — the results-view entry point. */
  public async search(
    query: string,
    limit: number = 25
  ): Promise<LocalSearchResults> {
    const [notes, dms] = await Promise.all([
      this.searchNotes(query, limit),
      this.searchDMs(query, limit),
    ]);
    return { notes, dms };
  }

  public getStats(): { notes: number; dms: number | null } {
    return {
      notes: this.noteIndex.documentCount,
      dms: this.dmIndex ? this.dmIndex.documentCount : null,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private indexNote(event: NostrEvent): void {
    const kind = event.kind ?? 0;
    if (!NOTE_SEARCHABLE_KINDS.has(kind)) return;
    const id = event.id ?? '';
    if (!id || this.indexedNoteIds.has(id)) return;
    const doc: NoteDoc = {
      id,
      kind,
      pubkey: event.pubkey ?? '',
      createdAt: event.created_at ?? 0,
      content: event.content ?? '',
    };
    if (kind === 30023) {
      const title = event.tags.find(t => t[0] === 'title')?.[1];
      if (title) doc.title = title;
    }
    this.noteIndex.add(doc);
    this.indexedNoteIds.add(id);
  }

  private dmDocFrom(message: DMMessage): DmDoc {
    return {
      id: message.id,
      pubkey: message.pubkey,
      conversationWith: message.conversationWith,
      createdAt: message.createdAt,
      isMine: message.isMine,
      content: message.content,
      ...(message.subject ? { subject: message.subject } : {}),
    };
  }

  /** Build the DM index once per account lifetime (lazy, in-memory only). */
  private ensureDmIndex(): Promise<void> {
    this.dmIndexBuilding ??= (async () => {
      const messages = await DMStore.getInstance().getAllMessages();
      const recent = messages
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_DM_DOCS);
      this.dmIndex = new MiniSearch<DmDoc>({
        fields: ['content', 'subject'],
        storeFields: ['pubkey', 'conversationWith', 'createdAt', 'isMine'],
      });
      this.dmIndex.addAll(recent.map(m => this.dmDocFrom(m)));
      for (const message of recent) this.indexedDmIds.add(message.id);
      diagLog('system', 'local_search_dm_index_built', {
        count: recent.length,
      });
    })();
    return this.dmIndexBuilding;
  }
}
