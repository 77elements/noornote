/**
 * NospressOrchestrator
 * Manages NIP-78 events for NosPress page content (per slug).
 *
 * d-tag scheme:
 *  - slug=''            → "noornote/list"          (legacy home, BC)
 *  - slug='about'       → "noornote/page/about"
 *
 * v1 (`{version:1, sections}`) is migrated to v2 inline on read; the home
 * slot keeps the legacy d-tag forever so older clients see a usable event.
 *
 * @purpose Publish/fetch NosPress pages to/from relays
 * @used-by NospressView, AutoSyncService, PublicNospressPage
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { NospressService, type NospressListData } from '../NospressService';
import { isPageV2, type NospressPageV2 } from '../../addons/nospress/blocks/types';
import { migrateV1ToV2 } from '../../addons/nospress/blocks/migrate';
import { HOME_SLUG, GLOBAL_HEADER_SLUG, GLOBAL_FOOTER_SLUG } from '../../addons/nospress/blocks/pageIndex';
import { SystemLogger } from '../../components/system/SystemLogger';
import { DeletionService } from '../DeletionService';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { diagLog } from '../DiagnosticLogger';

const NIP78_KIND = 30078;
const HOME_D_TAG = 'noornote/list';

function dTagFor(slug: string): string {
  if (slug === GLOBAL_HEADER_SLUG) return 'noornote/header';
  if (slug === GLOBAL_FOOTER_SLUG) return 'noornote/footer';
  return slug === HOME_SLUG ? HOME_D_TAG : `noornote/page/${slug}`;
}

export class NospressOrchestrator {
  private static instance: NospressOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private listService: NospressService;
  private systemLogger: SystemLogger;

  /** Cache key: `${pubkey}::${slug}` to keep slugs separate per author. */
  private cache: Map<string, { page: NospressPageV2 | null; fetchedAt: number }> = new Map();
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

  /** Legacy v1 publish — only valid for the home slug. */
  public async publishToRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const listData = this.listService.getList();

    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', HOME_D_TAG]],
      content: JSON.stringify(listData),
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign list event');

    await this.transport.publish(writeRelays, signed);

    this.invalidateCache(currentUser.pubkey, HOME_SLUG);

    diagLog('lists', 'NospressOrchestrator publishToRelays', {
      sectionCount: listData.sections.length
    });

    this.systemLogger.info('NospressOrchestrator',
      `Published NosPress list: ${listData.sections.length} sections`
    );
  }

  /**
   * Publish a v2 page to relays under the given slug. The home slug stays
   * on the legacy d-tag `noornote/list` so older clients keep working.
   */
  public async publishV2ToRelays(page: NospressPageV2, slug: string = HOME_SLUG): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const dTag = dTagFor(slug);
    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', dTag]],
      content: JSON.stringify(page),
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign v2 page event');

    await this.transport.publish(writeRelays, signed);
    this.invalidateCache(currentUser.pubkey, slug);

    diagLog('lists', 'NospressOrchestrator publishV2ToRelays', {
      slug,
      dTag,
      blockCount: page.blocks.length,
      hasTitle: !!page.title,
      hasSubtitle: !!page.subtitle,
      hasDescription: !!page.description,
    });

    this.systemLogger.info('NospressOrchestrator',
      `Published NosPress v2 (${dTag}): ${page.blocks.length} blocks`
    );
  }

  public async deleteFromRelays(slug: string = HOME_SLUG): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const dTag = dTagFor(slug);
    const coordinate = `${NIP78_KIND}:${currentUser.pubkey}:${dTag}`;
    const ok = await DeletionService.getInstance().deleteEvents({ coordinates: [coordinate] });
    if (!ok) throw new Error('Failed to publish NIP-09 deletion event');

    this.cache.set(this.cacheKey(currentUser.pubkey, slug), { page: null, fetchedAt: Date.now() });
    diagLog('lists', 'NospressOrchestrator deleteFromRelays', { coordinate });
  }

  /**
   * Fetch the latest published page for a pubkey + slug, normalized to v2.
   * Uses NIP-65 outbox discovery so any NoorNote user can read any other
   * user's NosPress pages even when relay sets don't overlap.
   */
  public async fetchFromRelays(
    pubkey: string,
    forceRefresh: boolean = false,
    slug: string = HOME_SLUG
  ): Promise<NospressPageV2 | null> {
    const ckey = this.cacheKey(pubkey, slug);
    if (!forceRefresh) {
      const cached = this.cache.get(ckey);
      if (cached && (Date.now() - cached.fetchedAt) < this.CACHE_TTL) {
        return cached.page;
      }
    }

    const relays = await OutboundRelaysOrchestrator.getInstance().getCombinedRelays([pubkey], true);
    if (relays.length === 0) return null;

    const dTag = dTagFor(slug);
    try {
      const events = await this.transport.fetch(relays, [{
        kinds: [NIP78_KIND],
        authors: [pubkey],
        '#d': [dTag],
        limit: 1
      }], 5000, false, 'NospressOrch');

      if (events.length === 0) {
        this.cache.set(ckey, { page: null, fetchedAt: Date.now() });
        return null;
      }

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event) return null;

      const page = this.parseContent(event.content);

      this.cache.set(ckey, { page, fetchedAt: Date.now() });
      return page;
    } catch (error) {
      this.systemLogger.error('NospressOrchestrator',
        `Failed to fetch page for ${pubkey} (${dTag}): ${error}`
      );
      return null;
    }
  }

  public async syncFromRelays(slug: string = HOME_SLUG): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const page = await this.fetchFromRelays(currentUser.pubkey, true, slug);
    if (page && page.blocks.length > 0) {
      this.listService.savePublishedV2(page, slug);
    }

    diagLog('lists', 'NospressOrchestrator syncFromRelays', {
      slug,
      blockCount: page?.blocks.length ?? 0
    });
  }

  public clearCache(pubkey?: string): void {
    if (pubkey) {
      for (const k of Array.from(this.cache.keys())) {
        if (k.startsWith(`${pubkey}::`)) this.cache.delete(k);
      }
    } else {
      this.cache.clear();
    }
  }

  private invalidateCache(pubkey: string, slug: string): void {
    this.cache.delete(this.cacheKey(pubkey, slug));
  }

  private cacheKey(pubkey: string, slug: string): string {
    return `${pubkey}::${slug}`;
  }

  /**
   * Parse the NIP-78 event content as a v2 page. v1 events are migrated to
   * v2 inline (sections → list blocks).
   */
  private parseContent(content: string): NospressPageV2 | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content);
      if (isPageV2(parsed)) {
        const page: NospressPageV2 = { version: 2, blocks: parsed.blocks };
        if (typeof parsed.title === 'string') page.title = parsed.title;
        if (typeof parsed.subtitle === 'string') page.subtitle = parsed.subtitle;
        if (typeof parsed.description === 'string') page.description = parsed.description;
        if (parsed.style && typeof parsed.style === 'object') page.style = parsed.style;
        if (typeof parsed.customCss === 'string') page.customCss = parsed.customCss;
        return page;
      }
      if (parsed && parsed.version === 1 && Array.isArray(parsed.sections)) {
        const v1: NospressListData = { version: 1, sections: parsed.sections };
        if (typeof parsed.title === 'string') v1.title = parsed.title;
        if (typeof parsed.subtitle === 'string') v1.subtitle = parsed.subtitle;
        if (typeof parsed.description === 'string') v1.description = parsed.description;
        return migrateV1ToV2(v1, []);
      }
      return null;
    } catch {
      return null;
    }
  }
}
