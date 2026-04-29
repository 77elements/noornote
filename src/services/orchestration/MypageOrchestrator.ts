/**
 * MypageOrchestrator
 * Manages NIP-78 events for My Page custom lists
 *
 * kind:30078 with d-tag "noornote/list" stores a user's custom list
 * (freetext sections with items — skills, hobbies, books, projects, anything).
 *
 * The d-tag stays "noornote/list" for backward compatibility with previously
 * published events. Internal naming is "mypage" since 2026-04-28 reframe.
 *
 * @purpose Publish/fetch My Page lists to/from relays
 * @used-by MypageView, MypageEditorView, AutoSyncService
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { MypageService, type MypageListData } from '../MypageService';
import type { MypagePageV2 } from '../../addons/mypage/blocks/types';
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';

const NIP78_KIND = 30078;
const D_TAG = 'noornote/list';

export class MypageOrchestrator {
  private static instance: MypageOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private listService: MypageService;
  private systemLogger: SystemLogger;

  private cache: Map<string, { data: MypageListData | null; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL = 60000;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.listService = MypageService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): MypageOrchestrator {
    if (!MypageOrchestrator.instance) {
      MypageOrchestrator.instance = new MypageOrchestrator();
    }
    return MypageOrchestrator.instance;
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

    diagLog('lists', 'MypageOrchestrator publishToRelays', {
      sectionCount: listData.sections.length
    });

    this.systemLogger.info('MypageOrchestrator',
      `Published My Page list: ${listData.sections.length} sections`
    );
  }

  /**
   * Publish a v2 (block-based) page to relays. Same NIP-78 slot as v1
   * (kind:30078, d-tag noornote/list) — v2 events overwrite v1 because the
   * d-tag matches. Older NoorNote installations reading v1-only will see
   * an empty page until they're updated; the only current user is the
   * developer so this is acceptable transitional state.
   */
  public async publishV2ToRelays(page: MypagePageV2): Promise<void> {
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

    diagLog('lists', 'MypageOrchestrator publishV2ToRelays', {
      blockCount: page.blocks.length,
      hasTitle: !!page.title,
      hasSubtitle: !!page.subtitle,
      hasDescription: !!page.description,
    });

    this.systemLogger.info('MypageOrchestrator',
      `Published My Page v2: ${page.blocks.length} blocks`
    );
  }

  public async deleteFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const emptyData: MypageListData = { version: 1, sections: [] };

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

    diagLog('lists', 'MypageOrchestrator deleteFromRelays', {});
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<MypageListData | null> {
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
      }], 5000, false, 'MypageOrch');

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
      this.systemLogger.error('MypageOrchestrator',
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

    diagLog('lists', 'MypageOrchestrator syncFromRelays', {
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

  private parseContent(content: string): MypageListData | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content) as MypageListData;
      if (parsed.version !== 1 || !Array.isArray(parsed.sections)) return null;
      const data: MypageListData = { version: 1, sections: parsed.sections };
      if (typeof parsed.title === 'string') data.title = parsed.title;
      if (typeof parsed.subtitle === 'string') data.subtitle = parsed.subtitle;
      if (typeof parsed.description === 'string') data.description = parsed.description;
      return data;
    } catch {
      return null;
    }
  }
}
