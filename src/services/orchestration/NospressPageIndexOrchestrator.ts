/**
 * NospressPageIndexOrchestrator
 * NIP-78 (kind:30078) publish/fetch for the NosPress multi-page index
 * under d-tag "noornote/page-index".
 *
 * @purpose Persist + retrieve the page-index across devices and clients
 * @used-by NospressView (Pages tab)
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { NospressPageIndexService } from '../NospressPageIndexService';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import {
  isPageIndex,
  type NospressPageIndex,
} from '../../addons/nospress/blocks/pageIndex';

const NIP78_KIND = 30078;
const D_TAG = 'noornote/page-index';

export class NospressPageIndexOrchestrator {
  private static instance: NospressPageIndexOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private indexService: NospressPageIndexService;
  private systemLogger: SystemLogger;

  private cache: Map<string, { index: NospressPageIndex | null; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL = 60000;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.indexService = NospressPageIndexService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): NospressPageIndexOrchestrator {
    if (!NospressPageIndexOrchestrator.instance) {
      NospressPageIndexOrchestrator.instance = new NospressPageIndexOrchestrator();
    }
    return NospressPageIndexOrchestrator.instance;
  }

  public async publishToRelays(index: NospressPageIndex): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', D_TAG]],
      content: JSON.stringify(index),
      pubkey: currentUser.pubkey,
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign page-index event');

    await this.transport.publish(writeRelays, signed);
    this.cache.delete(currentUser.pubkey);

    diagLog('lists', 'NospressPageIndexOrchestrator publishToRelays', {
      pageCount: index.pages.length,
    });
    this.systemLogger.info('NospressPageIndexOrchestrator',
      `Published NosPress page-index: ${index.pages.length} pages`
    );
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NospressPageIndex | null> {
    if (!forceRefresh) {
      const cached = this.cache.get(pubkey);
      if (cached && (Date.now() - cached.fetchedAt) < this.CACHE_TTL) {
        return cached.index;
      }
    }

    const relays = await OutboundRelaysOrchestrator.getInstance().getCombinedRelays([pubkey], true);
    if (relays.length === 0) return null;

    try {
      const events = await this.transport.fetch(relays, [{
        kinds: [NIP78_KIND],
        authors: [pubkey],
        '#d': [D_TAG],
        limit: 1,
      }], 5000, false, 'NospressPageIndexOrch');

      if (events.length === 0) {
        this.cache.set(pubkey, { index: null, fetchedAt: Date.now() });
        return null;
      }

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event) return null;

      const parsed = this.parseContent(event.content);
      this.cache.set(pubkey, { index: parsed, fetchedAt: Date.now() });
      return parsed;
    } catch (error) {
      this.systemLogger.error('NospressPageIndexOrchestrator',
        `Failed to fetch page-index for ${pubkey}: ${error}`
      );
      return null;
    }
  }

  public async syncFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const remote = await this.fetchFromRelays(currentUser.pubkey, true);
    if (remote) this.indexService.setIndexFromRelay(remote);

    diagLog('lists', 'NospressPageIndexOrchestrator syncFromRelays', {
      pageCount: remote?.pages.length ?? 0,
    });
  }

  public clearCache(pubkey?: string): void {
    if (pubkey) this.cache.delete(pubkey);
    else this.cache.clear();
  }

  private parseContent(content: string): NospressPageIndex | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content);
      return isPageIndex(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
