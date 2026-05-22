/**
 * NospressPageIndexOrchestrator
 * NIP-78 (kind:30078) publish/fetch for the NosPress multi-page index
 * under d-tag "noornote/page-index".
 *
 * Thin wrapper over Nip78ResourceOrchestrator — see that file for the
 * shared NIP-78 lifecycle.
 *
 * @purpose Persist + retrieve the page-index across devices and clients
 * @used-by NospressView (Pages tab)
 */

import { AuthService } from '../AuthService';
import { NospressPageIndexService } from '../NospressPageIndexService';
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import { Nip78ResourceOrchestrator } from './Nip78ResourceOrchestrator';
import {
  isPageIndex,
  type NospressPageIndex,
} from '../../addons/nospress/blocks/pageIndex';

export class NospressPageIndexOrchestrator {
  private static instance: NospressPageIndexOrchestrator | null = null;
  private resource: Nip78ResourceOrchestrator<NospressPageIndex>;
  private indexService: NospressPageIndexService;
  private systemLogger: SystemLogger;

  private constructor() {
    this.indexService = NospressPageIndexService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.resource = new Nip78ResourceOrchestrator<NospressPageIndex>({
      name: 'NospressPageIndexOrchestrator',
      fetchLabel: 'NospressPageIndexOrch',
      dTagFor: () => 'noornote/page-index',
      parse: (content) => {
        if (!content) return null;
        try {
          const parsed = JSON.parse(content);
          return isPageIndex(parsed) ? parsed : null;
        } catch { return null; }
      },
    });
  }

  public static getInstance(): NospressPageIndexOrchestrator {
    if (!NospressPageIndexOrchestrator.instance) {
      NospressPageIndexOrchestrator.instance = new NospressPageIndexOrchestrator();
    }
    return NospressPageIndexOrchestrator.instance;
  }

  public destroy(): void {
    this.resource.destroyCache();
    NospressPageIndexOrchestrator.instance = null;
  }

  public async publishToRelays(index: NospressPageIndex): Promise<void> {
    await this.resource.publish(index, '', { pageCount: index.pages.length });
    this.systemLogger.info('NospressPageIndexOrchestrator',
      `Published NosPress page-index: ${index.pages.length} pages`
    );
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NospressPageIndex | null> {
    return this.resource.fetch(pubkey, '', forceRefresh);
  }

  public async syncFromRelays(): Promise<void> {
    const currentUser = AuthService.getInstance().getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const remote = await this.resource.fetch(currentUser.pubkey, '', true);
    if (remote) this.indexService.setIndexFromRelay(remote);

    diagLog('lists', 'NospressPageIndexOrchestrator syncFromRelays', {
      pageCount: remote?.pages.length ?? 0,
    });
  }

  /** Kind:5 deletion of the addressable coordinate. Used by the Global-tab
   *  "Danger Zone → Delete from relays" path so a full site wipe can take
   *  the page-index event off the user's relays too. */
  public async deleteFromRelays(): Promise<void> {
    await this.resource.delete('');
  }

  public clearCache(pubkey?: string): void {
    this.resource.clearCache(pubkey);
  }
}
