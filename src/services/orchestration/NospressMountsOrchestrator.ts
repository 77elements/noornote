/**
 * NospressMountsOrchestrator
 * Manages NIP-78 events for My-Page-mounted bookmark folders
 *
 * kind:30078 with d-tag "noornote/nospress-mounts" stores which bookmark
 * folders a user has mounted to their NosPress subpage.
 *
 * Sister orchestrator to ProfileMountsOrchestrator (which uses d-tag
 * "noornote/profile-mounts" for PV-inline mounts). Independent storage,
 * independent surface — strict separation per Phase 2 design.
 *
 * @purpose Publish/fetch NosPress mounts to/from relays
 * @used-by NospressView, BookmarkSecondaryManager
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { NospressMountsService } from '../NospressMountsService';
import { SystemLogger } from '../SystemLogger';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';

const NIP78_KIND = 30078;
const D_TAG = 'noornote/nospress-mounts';

interface NospressMountsContent {
  version: 1;
  mounts: string[];
}

export class NospressMountsOrchestrator {
  private static instance: NospressMountsOrchestrator | null = null;
  private transport: NostrTransport;
  private authService: AuthService;
  private nospressMountsService: NospressMountsService;
  private systemLogger: SystemLogger;

  private cache = new LRUCache<string[]>(getCacheSize(100, 50, 30), 60000);

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.nospressMountsService = NospressMountsService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): NospressMountsOrchestrator {
    if (!NospressMountsOrchestrator.instance) {
      NospressMountsOrchestrator.instance = new NospressMountsOrchestrator();
    }
    return NospressMountsOrchestrator.instance;
  }

  /** Tear down. See NospressOrchestrator.destroy() for rationale. */
  public destroy(): void {
    this.cache.clear();
    NospressMountsOrchestrator.instance = null;
  }

  public async publishToRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) {
      throw new Error('No write relays available');
    }

    const mounts = this.nospressMountsService.getMounts();

    const content: NospressMountsContent = {
      version: 1,
      mounts
    };

    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', D_TAG]],
      content: JSON.stringify(content),
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) {
      throw new Error('Failed to sign NosPress mounts event');
    }

    await this.transport.publishContent(signed);

    this.cache.set(currentUser.pubkey, mounts);

    this.systemLogger.info('NospressMountsOrchestrator',
      `Published NosPress mounts: ${mounts.length} folders`
    );
  }

  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<string[]> {
    if (!forceRefresh) {
      const cached = this.cache.get(pubkey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const readRelays = this.transport.getReadRelays();
    if (readRelays.length === 0) {
      return [];
    }

    try {
      const events = await this.transport.fetch(readRelays, [{
        kinds: [NIP78_KIND],
        authors: [pubkey],
        '#d': [D_TAG],
        limit: 1
      }], 5000, false, 'NospressMountsOrch');

      if (events.length === 0) {
        this.cache.set(pubkey, []);
        return [];
      }

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event) return [];

      const mounts = this.parseContent(event.content);

      this.cache.set(pubkey, mounts);

      return mounts;
    } catch (error) {
      this.systemLogger.error('NospressMountsOrchestrator',
        `Failed to fetch NosPress mounts for ${pubkey}: ${error}`
      );
      return [];
    }
  }

  public async syncFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const mounts = await this.fetchFromRelays(currentUser.pubkey, true);
    this.nospressMountsService.setMountsFromRelay(mounts);

    this.systemLogger.info('NospressMountsOrchestrator',
      `Synced from relays: ${mounts.length} folders`
    );
  }

  public clearCache(pubkey?: string): void {
    if (pubkey) {
      this.cache.delete(pubkey);
    } else {
      this.cache.clear();
    }
  }

  private parseContent(content: string): string[] {
    if (!content) return [];

    try {
      const parsed = JSON.parse(content) as NospressMountsContent;
      if (parsed.version === 1 && Array.isArray(parsed.mounts)) {
        return parsed.mounts;
      }
      return [];
    } catch {
      return [];
    }
  }
}
