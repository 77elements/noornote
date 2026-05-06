/**
 * NospressSiteSettingsOrchestrator
 * NIP-78 (kind:30078) publish/fetch for NosPress site-wide settings under
 * d-tag `noornote/site-settings`.
 *
 * @purpose Persist + retrieve site meta/theme/injection across devices/clients
 * @used-by NospressView (Global tab), PublicNospressPage (head/theme apply)
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { NospressSiteSettingsService } from '../NospressSiteSettingsService';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { SystemLogger } from '../../components/system/SystemLogger';
import { DeletionService } from '../DeletionService';
import { diagLog } from '../DiagnosticLogger';
import {
  isSiteSettings,
  hasSiteSettingsContent,
  type NospressSiteSettings,
} from '../../addons/nospress/blocks/siteSettings';

const NIP78_KIND = 30078;
const D_TAG = 'noornote/site-settings';

export class NospressSiteSettingsOrchestrator {
  private static instance: NospressSiteSettingsOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private settingsService: NospressSiteSettingsService;
  private systemLogger: SystemLogger;

  private cache: Map<string, { settings: NospressSiteSettings | null; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL = 60000;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.settingsService = NospressSiteSettingsService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): NospressSiteSettingsOrchestrator {
    if (!NospressSiteSettingsOrchestrator.instance) {
      NospressSiteSettingsOrchestrator.instance = new NospressSiteSettingsOrchestrator();
    }
    return NospressSiteSettingsOrchestrator.instance;
  }

  public async publishToRelays(settings: NospressSiteSettings): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', D_TAG]],
      content: JSON.stringify(settings),
      pubkey: currentUser.pubkey,
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign site-settings event');

    await this.transport.publish(writeRelays, signed);
    this.cache.delete(currentUser.pubkey);

    diagLog('lists', 'NospressSiteSettingsOrchestrator publishToRelays', {
      hasMeta: !!settings.meta,
      hasTheme: !!settings.theme,
      hasInjection: !!settings.injection,
    });
    this.systemLogger.info('NospressSiteSettingsOrchestrator',
      `Published NosPress site-settings`
    );
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NospressSiteSettings | null> {
    if (!forceRefresh) {
      const cached = this.cache.get(pubkey);
      if (cached && (Date.now() - cached.fetchedAt) < this.CACHE_TTL) {
        return cached.settings;
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
      }], 5000, false, 'NospressSiteSettingsOrch');

      if (events.length === 0) {
        this.cache.set(pubkey, { settings: null, fetchedAt: Date.now() });
        return null;
      }

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event) return null;

      const parsed = this.parseContent(event.content);
      this.cache.set(pubkey, { settings: parsed, fetchedAt: Date.now() });
      return parsed;
    } catch (error) {
      this.systemLogger.error('NospressSiteSettingsOrchestrator',
        `Failed to fetch site-settings for ${pubkey}: ${error}`
      );
      return null;
    }
  }

  public async syncFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const remote = await this.fetchFromRelays(currentUser.pubkey, true);
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
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const coordinate = `${NIP78_KIND}:${currentUser.pubkey}:${D_TAG}`;
    const ok = await DeletionService.getInstance().deleteEvents({ coordinates: [coordinate] });
    if (!ok) throw new Error('Failed to publish NIP-09 deletion event');

    this.cache.set(currentUser.pubkey, { settings: null, fetchedAt: Date.now() });
    diagLog('lists', 'NospressSiteSettingsOrchestrator deleteFromRelays', { coordinate });
  }

  public clearCache(pubkey?: string): void {
    if (pubkey) this.cache.delete(pubkey);
    else this.cache.clear();
  }

  private parseContent(content: string): NospressSiteSettings | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content);
      return isSiteSettings(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
