/**
 * NospressOrchestrator
 * Manages NIP-78 events for NosPress custom lists
 *
 * kind:30078 with d-tag "noornote/list" stores a user's custom list
 * (freetext sections with items — skills, hobbies, books, projects, anything).
 *
 * @purpose Publish/fetch NosPress lists to/from relays
 * @used-by NospressView, AutoSyncService
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { NospressService, type NospressListData } from '../NospressService';
import type { NospressPageV2 } from '../../addons/nospress/blocks/types';
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';

const NIP78_KIND = 30078;
const D_TAG = 'noornote/list';

export class NospressOrchestrator {
  private static instance: NospressOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private listService: NospressService;
  private systemLogger: SystemLogger;

  private cache: Map<string, { data: NospressListData | null; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL = 60000;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.listService = NospressService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): NospressOrchestrator {
    if (!NospressOrchestrator.instance) {
      NospressOrchestrator.instance = new NospressOrchestrator();
    }
    return NospressOrchestrator.instance;
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

    diagLog('lists', 'NospressOrchestrator publishToRelays', {
      sectionCount: listData.sections.length
    });

    this.systemLogger.info('NospressOrchestrator',
      `Published NosPress list: ${listData.sections.length} sections`
    );
  }

  /**
   * Publish a v2 (block-based) page to relays. Same NIP-78 slot as v1
   * (kind:30078, d-tag noornote/list) — v2 events overwrite v1 because the
   * d-tag matches. Older NoorNote installations reading v1-only will see
   * an empty page until they're updated; the only current user is the
   * developer so this is acceptable transitional state.
   */
  public async publishV2ToRelays(page: NospressPageV2): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', D_TAG]],
      content: JSON.stringify(page),
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign v2 page event');

    await this.transport.publish(writeRelays, signed);

    diagLog('lists', 'NospressOrchestrator publishV2ToRelays', {
      blockCount: page.blocks.length,
      hasTitle: !!page.title,
      hasSubtitle: !!page.subtitle,
      hasDescription: !!page.description,
    });

    this.systemLogger.info('NospressOrchestrator',
      `Published NosPress v2: ${page.blocks.length} blocks`
    );
  }

  public async deleteFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const emptyData: NospressListData = { version: 1, sections: [] };

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

    diagLog('lists', 'NospressOrchestrator deleteFromRelays', {});
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NospressListData | null> {
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
      }], 5000, false, 'NospressOrch');

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
      this.systemLogger.error('NospressOrchestrator',
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

    diagLog('lists', 'NospressOrchestrator syncFromRelays', {
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

  private parseContent(content: string): NospressListData | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content) as NospressListData;
      if (parsed.version !== 1 || !Array.isArray(parsed.sections)) return null;
      const data: NospressListData = { version: 1, sections: parsed.sections };
      if (typeof parsed.title === 'string') data.title = parsed.title;
      if (typeof parsed.subtitle === 'string') data.subtitle = parsed.subtitle;
      if (typeof parsed.description === 'string') data.description = parsed.description;
      return data;
    } catch {
      return null;
    }
  }
}
