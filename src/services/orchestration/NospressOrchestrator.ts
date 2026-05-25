/**
 * NospressOrchestrator
 * Manages NIP-78 events for NosPress page content (per slug).
 *
 * d-tag scheme:
 *  - slug=''                        → "noornote/list"   (legacy home, BC)
 *  - slug='about'                   → "noornote/page/about"
 *  - GLOBAL_HEADER_SLUG             → "noornote/header"
 *  - GLOBAL_FOOTER_SLUG             → "noornote/footer"
 *  - <home>__header / __footer      → "noornote/list/header" / "/footer"
 *  - <slug>__header / __footer      → "noornote/page/<slug>/header|footer"
 *
 * v1 (`{version:1, sections}`) is migrated to v2 inline on read; the home
 * slot keeps the legacy d-tag forever so older clients see a usable event.
 *
 * Wraps Nip78ResourceOrchestrator for the NIP-78 lifecycle. The legacy v1
 * publish path stays inline because its data source (NospressService.getList)
 * differs from the generic publish path (caller-supplied data).
 *
 * @purpose Publish/fetch NosPress pages to/from relays
 * @used-by NospressView, AutoSyncService, PublicNospressPage
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { NospressService, type NospressListData } from '../NospressService';
import { isPageV2, normalizePage, type NospressPageV2 } from '../../addons/nospress/blocks/types';
import { migrateV1ToV2 } from '../../addons/nospress/blocks/migrate';
import {
  HOME_SLUG,
  GLOBAL_HEADER_SLUG,
  GLOBAL_FOOTER_SLUG,
  isPageHeaderSlug,
  isPageFooterSlug,
  extractPagePart,
} from '../../addons/nospress/blocks/pageIndex';
import { SystemLogger } from '../SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import { Nip78ResourceOrchestrator } from './Nip78ResourceOrchestrator';

const NIP78_KIND = 30078;
const HOME_D_TAG = 'noornote/list';

function dTagFor(slug: string): string {
  if (slug === GLOBAL_HEADER_SLUG) return 'noornote/header';
  if (slug === GLOBAL_FOOTER_SLUG) return 'noornote/footer';
  if (isPageHeaderSlug(slug)) {
    const pageSlug = extractPagePart(slug);
    return pageSlug === HOME_SLUG ? 'noornote/list/header' : `noornote/page/${pageSlug}/header`;
  }
  if (isPageFooterSlug(slug)) {
    const pageSlug = extractPagePart(slug);
    return pageSlug === HOME_SLUG ? 'noornote/list/footer' : `noornote/page/${pageSlug}/footer`;
  }
  return slug === HOME_SLUG ? HOME_D_TAG : `noornote/page/${slug}`;
}

/**
 * Parse the NIP-78 event content as a v2 page. v1 events are migrated to
 * v2 inline (sections → list blocks).
 */
function parsePageContent(content: string): NospressPageV2 | null {
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
      return normalizePage(page);
    }
    if (parsed && parsed.version === 1 && Array.isArray(parsed.sections)) {
      const v1: NospressListData = { version: 1, sections: parsed.sections };
      if (typeof parsed.title === 'string') v1.title = parsed.title;
      if (typeof parsed.subtitle === 'string') v1.subtitle = parsed.subtitle;
      if (typeof parsed.description === 'string') v1.description = parsed.description;
      return normalizePage(migrateV1ToV2(v1, []));
    }
    return null;
  } catch {
    return null;
  }
}

export class NospressOrchestrator {
  private static instance: NospressOrchestrator | null = null;
  private resource: Nip78ResourceOrchestrator<NospressPageV2>;
  private transport: NostrTransport;
  private authService: AuthService;
  private listService: NospressService;
  private systemLogger: SystemLogger;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.listService = NospressService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.resource = new Nip78ResourceOrchestrator<NospressPageV2>({
      name: 'NospressOrchestrator',
      fetchLabel: 'NospressOrch',
      dTagFor,
      parse: parsePageContent,
    });
  }

  public static getInstance(): NospressOrchestrator {
    if (!NospressOrchestrator.instance) {
      NospressOrchestrator.instance = new NospressOrchestrator();
    }
    return NospressOrchestrator.instance;
  }

  /**
   * Tear down the in-memory cache and release the singleton. Called by
   * NospressRuntime.destroy() on toggle-OFF, logout, or account switch.
   * Persistent NIP-78 state on relays / in PerAccountLocalStorage is not
   * touched.
   */
  public destroy(): void {
    this.resource.destroyCache();
    NospressOrchestrator.instance = null;
  }

  /**
   * Legacy v1 publish — only valid for the home slug. Kept inline because
   * its data source is the NospressService list, not a caller-supplied
   * page (the generic publish path expects the caller to hand over the
   * data to write).
   */
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
      pubkey: currentUser.pubkey,
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) throw new Error('Failed to sign list event');

    await this.transport.publishContent(signed);

    this.resource.invalidate(currentUser.pubkey, HOME_SLUG);

    diagLog('lists', 'NospressOrchestrator publishToRelays', {
      sectionCount: listData.sections.length,
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
    await this.resource.publish(page, slug, {
      slug,
      blockCount: page.blocks.length,
      hasTitle: !!page.title,
      hasSubtitle: !!page.subtitle,
      hasDescription: !!page.description,
    });
    this.systemLogger.info('NospressOrchestrator',
      `Published NosPress v2 (${dTagFor(slug)}): ${page.blocks.length} blocks`
    );
  }

  public async deleteFromRelays(slug: string = HOME_SLUG): Promise<void> {
    await this.resource.delete(slug);
  }

  /**
   * Fetch the latest published page for a pubkey + slug, normalized to v2.
   */
  public async fetchFromRelays(
    pubkey: string,
    forceRefresh: boolean = false,
    slug: string = HOME_SLUG
  ): Promise<NospressPageV2 | null> {
    return this.resource.fetch(pubkey, slug, forceRefresh);
  }

  public async syncFromRelays(slug: string = HOME_SLUG): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const page = await this.resource.fetch(currentUser.pubkey, slug, true);
    if (page && page.blocks.length > 0) {
      this.listService.savePublishedV2(page, slug);
    }

    diagLog('lists', 'NospressOrchestrator syncFromRelays', {
      slug,
      blockCount: page?.blocks.length ?? 0,
    });
  }

  public clearCache(pubkey?: string): void {
    this.resource.clearCache(pubkey);
  }
}
