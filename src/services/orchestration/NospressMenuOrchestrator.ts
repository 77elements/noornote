/**
 * NospressMenuOrchestrator
 * NIP-78 (kind:30078) publish/fetch for the NosPress site menus
 * under d-tag "noornote/menus".
 *
 * @purpose Persist + retrieve site menus across devices/clients
 * @used-by NospressView (Nav tab), public-page navigation rendering (Slice 2.5)
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { NospressMenuService } from '../NospressMenuService';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import {
  isMenuSet,
  type NospressMenuSet,
} from '../../addons/nospress/blocks/menu';

const NIP78_KIND = 30078;
const D_TAG = 'noornote/menus';

export class NospressMenuOrchestrator {
  private static instance: NospressMenuOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private menuService: NospressMenuService;
  private systemLogger: SystemLogger;

  private cache: Map<string, { set: NospressMenuSet | null; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL = 60000;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.menuService = NospressMenuService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): NospressMenuOrchestrator {
    if (!NospressMenuOrchestrator.instance) {
      NospressMenuOrchestrator.instance = new NospressMenuOrchestrator();
    }
    return NospressMenuOrchestrator.instance;
  }

  public async publishToRelays(set: NospressMenuSet): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', D_TAG]],
      content: JSON.stringify(set),
      pubkey: currentUser.pubkey,
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign menus event');

    await this.transport.publish(writeRelays, signed);
    this.cache.delete(currentUser.pubkey);

    diagLog('lists', 'NospressMenuOrchestrator publishToRelays', {
      menuCount: set.menus.length,
      itemCounts: set.menus.map(m => m.items.length),
    });
    this.systemLogger.info('NospressMenuOrchestrator',
      `Published NosPress menus: ${set.menus.length} menus`
    );
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NospressMenuSet | null> {
    if (!forceRefresh) {
      const cached = this.cache.get(pubkey);
      if (cached && (Date.now() - cached.fetchedAt) < this.CACHE_TTL) {
        return cached.set;
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
      }], 5000, false, 'NospressMenuOrch');

      if (events.length === 0) {
        this.cache.set(pubkey, { set: null, fetchedAt: Date.now() });
        return null;
      }

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event) return null;

      const parsed = this.parseContent(event.content);
      this.cache.set(pubkey, { set: parsed, fetchedAt: Date.now() });
      return parsed;
    } catch (error) {
      this.systemLogger.error('NospressMenuOrchestrator',
        `Failed to fetch menus for ${pubkey}: ${error}`
      );
      return null;
    }
  }

  public async syncFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const remote = await this.fetchFromRelays(currentUser.pubkey, true);
    if (remote) this.menuService.setMenuSetFromRelay(remote);

    diagLog('lists', 'NospressMenuOrchestrator syncFromRelays', {
      menuCount: remote?.menus.length ?? 0,
    });
  }

  public clearCache(pubkey?: string): void {
    if (pubkey) this.cache.delete(pubkey);
    else this.cache.clear();
  }

  private parseContent(content: string): NospressMenuSet | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content);
      return isMenuSet(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
