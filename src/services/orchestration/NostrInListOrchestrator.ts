/**
 * NostrInListOrchestrator
 * Manages NIP-78 events for professional lists (NostrIn addon)
 *
 * kind:30078 with d-tag "noornote/list" stores a user's professional
 * list (skills, experience, projects — freetext sections).
 *
 * @purpose Publish/fetch professional lists to/from relays
 * @used-by NostrInListView, NostrInListEditorView, AutoSyncService
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { NostrInListService, type NostrInListData } from '../NostrInListService';
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';

const NIP78_KIND = 30078;
const D_TAG = 'noornote/list';

export class NostrInListOrchestrator {
  private static instance: NostrInListOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private listService: NostrInListService;
  private systemLogger: SystemLogger;

  private cache: Map<string, { data: NostrInListData | null; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL = 60000;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.listService = NostrInListService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): NostrInListOrchestrator {
    if (!NostrInListOrchestrator.instance) {
      NostrInListOrchestrator.instance = new NostrInListOrchestrator();
    }
    return NostrInListOrchestrator.instance;
  }

  public async publishToRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const listData = this.listService.getList();

    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', D_TAG]],
      content: JSON.stringify(listData),
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign list event');

    await this.transport.publish(writeRelays, signed);

    this.cache.set(currentUser.pubkey, { data: listData, fetchedAt: Date.now() });

    diagLog('lists', 'NostrInListOrchestrator publishToRelays', {
      sectionCount: listData.sections.length
    });

    this.systemLogger.info('NostrInListOrchestrator',
      `Published professional list: ${listData.sections.length} sections`
    );
  }

  public async deleteFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const emptyData: NostrInListData = { version: 1, sections: [] };

    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', D_TAG]],
      content: JSON.stringify(emptyData),
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign deletion event');

    await this.transport.publish(writeRelays, signed);

    this.cache.set(currentUser.pubkey, { data: null, fetchedAt: Date.now() });

    diagLog('lists', 'NostrInListOrchestrator deleteFromRelays', {});
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NostrInListData | null> {
    if (!forceRefresh) {
      const cached = this.cache.get(pubkey);
      if (cached && (Date.now() - cached.fetchedAt) < this.CACHE_TTL) {
        return cached.data;
      }
    }

    const readRelays = this.transport.getReadRelays();
    if (readRelays.length === 0) return null;

    try {
      const events = await this.transport.fetch(readRelays, [{
        kinds: [NIP78_KIND],
        authors: [pubkey],
        '#d': [D_TAG],
        limit: 1
      }], 5000, false, 'NostrInListOrch');

      if (events.length === 0) {
        this.cache.set(pubkey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event) return null;

      const data = this.parseContent(event.content);

      this.cache.set(pubkey, { data, fetchedAt: Date.now() });
      return data;
    } catch (error) {
      this.systemLogger.error('NostrInListOrchestrator',
        `Failed to fetch list for ${pubkey}: ${error}`
      );
      return null;
    }
  }

  public async syncFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const data = await this.fetchFromRelays(currentUser.pubkey, true);
    if (data && data.sections.length > 0) {
      this.listService.setListFromRelay(data);
    }

    diagLog('lists', 'NostrInListOrchestrator syncFromRelays', {
      sectionCount: data?.sections.length ?? 0
    });
  }

  public clearCache(pubkey?: string): void {
    if (pubkey) {
      this.cache.delete(pubkey);
    } else {
      this.cache.clear();
    }
  }

  private parseContent(content: string): NostrInListData | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content) as NostrInListData;
      if (parsed.version === 1 && Array.isArray(parsed.sections)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}
