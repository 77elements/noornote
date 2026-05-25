/**
 * NospressSiteSettingsOrchestrator
 * NIP-78 (kind:30078) publish/fetch for NosPress site-wide settings under
 * d-tag `noornote/site-settings`.
 *
 * Thin wrapper over Nip78ResourceOrchestrator — see that file for the
 * shared NIP-78 lifecycle.
 *
 * @purpose Persist + retrieve site meta/theme/injection across devices/clients
 * @used-by NospressView (Global tab), PublicNospressPage (head/theme apply)
 */

import { AuthService } from '../AuthService';
import { NospressSiteSettingsService } from '../NospressSiteSettingsService';
import { SystemLogger } from '../SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import { Nip78ResourceOrchestrator } from './Nip78ResourceOrchestrator';
import {
  isSiteSettings,
  hasSiteSettingsContent,
  type NospressSiteSettings,
} from '../../addons/nospress/blocks/siteSettings';

export class NospressSiteSettingsOrchestrator {
  private static instance: NospressSiteSettingsOrchestrator | null = null;
  private resource: Nip78ResourceOrchestrator<NospressSiteSettings>;
  private settingsService: NospressSiteSettingsService;
  private systemLogger: SystemLogger;

  private constructor() {
    this.settingsService = NospressSiteSettingsService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.resource = new Nip78ResourceOrchestrator<NospressSiteSettings>({
      name: 'NospressSiteSettingsOrchestrator',
      fetchLabel: 'NospressSiteSettingsOrch',
      dTagFor: () => 'noornote/site-settings',
      parse: (content) => {
        if (!content) return null;
        try {
          const parsed = JSON.parse(content);
          return isSiteSettings(parsed) ? parsed : null;
        } catch { return null; }
      },
    });
  }

  public static getInstance(): NospressSiteSettingsOrchestrator {
    if (!NospressSiteSettingsOrchestrator.instance) {
      NospressSiteSettingsOrchestrator.instance = new NospressSiteSettingsOrchestrator();
    }
    return NospressSiteSettingsOrchestrator.instance;
  }

  public destroy(): void {
    this.resource.destroyCache();
    NospressSiteSettingsOrchestrator.instance = null;
  }

  public async publishToRelays(settings: NospressSiteSettings): Promise<void> {
    await this.resource.publish(settings, '', {
      hasMeta: !!settings.meta,
      hasTheme: !!settings.theme,
      hasInjection: !!settings.injection,
    });
    this.systemLogger.info('NospressSiteSettingsOrchestrator',
      `Published NosPress site-settings`
    );
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NospressSiteSettings | null> {
    return this.resource.fetch(pubkey, '', forceRefresh);
  }

  public async syncFromRelays(): Promise<void> {
    const currentUser = AuthService.getInstance().getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const remote = await this.resource.fetch(currentUser.pubkey, '', true);
    if (remote && hasSiteSettingsContent(remote)) {
      this.settingsService.setSettingsFromRelay(remote);
    }

    diagLog('lists', 'NospressSiteSettingsOrchestrator syncFromRelays', {
      hasContent: hasSiteSettingsContent(remote),
    });
  }

  /** Unpublish: kind:5 deletion of the addressable coordinate. Used by the
   *  Global-tab "Delete site settings" / "Reset everything" path. */
  public async deleteFromRelays(): Promise<void> {
    await this.resource.delete('');
  }

  public clearCache(pubkey?: string): void {
    this.resource.clearCache(pubkey);
  }
}
