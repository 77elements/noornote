/**
 * NospressMenuOrchestrator
 * NIP-78 (kind:30078) publish/fetch for the NosPress site menus
 * under d-tag "noornote/menus".
 *
 * Thin wrapper over Nip78ResourceOrchestrator — see that file for the
 * shared NIP-78 lifecycle (cache TTL, sign+publish via AuthService /
 * NostrTransport, NIP-65 outbox discovery on fetch).
 *
 * @purpose Persist + retrieve site menus across devices/clients
 * @used-by NospressView (Nav tab), public-page navigation rendering
 */

import { AuthService } from '../AuthService';
import { NospressMenuService } from '../NospressMenuService';
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import { Nip78ResourceOrchestrator } from './Nip78ResourceOrchestrator';
import {
  isMenuSet,
  type NospressMenuSet,
} from '../../addons/nospress/blocks/menu';

export class NospressMenuOrchestrator {
  private static instance: NospressMenuOrchestrator | null = null;
  private resource: Nip78ResourceOrchestrator<NospressMenuSet>;
  private menuService: NospressMenuService;
  private systemLogger: SystemLogger;

  private constructor() {
    this.menuService = NospressMenuService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.resource = new Nip78ResourceOrchestrator<NospressMenuSet>({
      name: 'NospressMenuOrchestrator',
      fetchLabel: 'NospressMenuOrch',
      dTagFor: () => 'noornote/menus',
      parse: (content) => {
        if (!content) return null;
        try {
          const parsed = JSON.parse(content);
          return isMenuSet(parsed) ? parsed : null;
        } catch { return null; }
      },
    });
  }

  public static getInstance(): NospressMenuOrchestrator {
    if (!NospressMenuOrchestrator.instance) {
      NospressMenuOrchestrator.instance = new NospressMenuOrchestrator();
    }
    return NospressMenuOrchestrator.instance;
  }

  public destroy(): void {
    this.resource.destroyCache();
    NospressMenuOrchestrator.instance = null;
  }

  public async publishToRelays(set: NospressMenuSet): Promise<void> {
    await this.resource.publish(set, '', {
      menuCount: set.menus.length,
      itemCounts: set.menus.map(m => m.items.length),
    });
    this.systemLogger.info('NospressMenuOrchestrator',
      `Published NosPress menus: ${set.menus.length} menus`
    );
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NospressMenuSet | null> {
    return this.resource.fetch(pubkey, '', forceRefresh);
  }

  public async syncFromRelays(): Promise<void> {
    const currentUser = AuthService.getInstance().getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const remote = await this.resource.fetch(currentUser.pubkey, '', true);
    if (remote) this.menuService.setMenuSetFromRelay(remote);

    diagLog('lists', 'NospressMenuOrchestrator syncFromRelays', {
      menuCount: remote?.menus.length ?? 0,
    });
  }

  /** Kind:5 deletion of the addressable coordinate. Used by the Global-tab
   *  "Danger Zone → Delete from relays" path so a full site wipe can take
   *  the menus event off the user's relays too. */
  public async deleteFromRelays(): Promise<void> {
    await this.resource.delete('');
  }

  public clearCache(pubkey?: string): void {
    this.resource.clearCache(pubkey);
  }
}
