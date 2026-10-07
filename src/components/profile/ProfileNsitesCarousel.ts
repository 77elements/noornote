/**
 * ProfileNsitesCarousel Component
 * Displays a user's NIP-5A static websites (nsite manifests, kind 15128 root /
 * 35128 named) as a card grid. Clicking a card opens the manifest in SNV.
 *
 * @component ProfileNsitesCarousel
 * @used-by ProfileView
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import { Router } from '../../services/Router';
import {
  isNsiteManifest,
  NSITE_NAMED_KIND,
} from '../ui/note-processing/NsiteProcessor';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { getTag } from '../../helpers/tagUtils';
import { diagLog } from '../../services/DiagnosticLogger';

interface NsiteCardData {
  event: NostrEvent;
  title: string;
  description: string;
  fileCount: number;
  route: string;
}

export class ProfileNsitesCarousel {
  private element: HTMLElement;
  private pubkey: string;
  private nsites: NsiteCardData[] = [];
  private _profileApi: ProfileModuleApi | null = null;
  private profileApiPromise: Promise<ProfileModuleApi> | null = null;

  /** Boot-race safe: loads the profile module on demand. */
  private ensureProfileApi(): Promise<ProfileModuleApi> {
    this.profileApiPromise ??= (async () => {
      this._profileApi ??=
        ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile');
      if (!this._profileApi) {
        const api =
          await ModuleLoader.getInstance().ensure<ProfileModuleApi>('profile');
        if (!api) {
          throw new Error('Profile module failed to load');
        }
        this._profileApi = api;
      }
      return this._profileApi;
    })();
    return this.profileApiPromise;
  }

  constructor(pubkey: string) {
    this.pubkey = pubkey;
    this.element = document.createElement('div');
    this.element.className = 'profile-nsites-carousel';
  }

  /**
   * Fetch nsites and render the grid. Self-gates: an author without nsites
   * gets an empty (display:none) element so the tab stays hidden.
   */
  public async render(): Promise<HTMLElement> {
    await this.fetchNsites();

    if (this.nsites.length === 0) {
      this.element.style.display = 'none';
      return this.element;
    }

    this.renderGrid();
    return this.element;
  }

  private async fetchNsites(): Promise<void> {
    try {
      // Shared fetch (read + aggregator + outbound relays) via the profile
      // module; reuses the same cached round-trip as the other carousels.
      const profileApi = await this.ensureProfileApi();
      const content = await profileApi.fetchCarouselContent(this.pubkey);

      this.nsites = content.nsites
        .filter(isNsiteManifest)
        .sort((a, b) => b.created_at - a.created_at)
        .map(event => {
          const title = getTag(event.tags, 'title')?.trim() || 'Nostr website';
          const fileCount = event.tags.filter(
            t => t[0] === 'path' && t[1]
          ).length;
          return {
            event,
            title,
            description: getTag(event.tags, 'description')?.trim() || '',
            fileCount,
            route: NsiteCardRoute(event),
          };
        });

      diagLog('system', 'NsitesCarousel: loaded', {
        count: this.nsites.length,
        sites: this.nsites.map(n => ({
          kind: n.event.kind,
          title: n.title.slice(0, 30),
          files: n.fileCount,
        })),
      });
    } catch (error) {
      console.debug('[ProfileNsitesCarousel] Failed to fetch nsites:', error);
      this.nsites = [];
    }
  }

  private renderGrid(): void {
    const grid = document.createElement('div');
    grid.className = 'nn-card-grid nn-card-grid--nonresponsive';

    grid.innerHTML = this.nsites
      .map(
        site => `
      <div class="nn-card profile-nsites-carousel__card" data-route="${escapeHtmlAttr(site.route)}">
        <div class="nn-card__body">
          <div class="nn-card__title">🌐 ${escapeHtml(site.title)}</div>
          ${site.description ? `<div class="nn-card__meta">${escapeHtml(site.description)}</div>` : ''}
          <div class="nn-card__meta">NIP-5A static website · ${site.fileCount} file${site.fileCount === 1 ? '' : 's'}</div>
        </div>
      </div>
    `
      )
      .join('');

    grid.querySelectorAll('.profile-nsites-carousel__card').forEach(card => {
      card.addEventListener('click', () => {
        const route = (card as HTMLElement).dataset.route;
        if (route) Router.getInstance().navigate(route);
      });
    });

    this.element.appendChild(grid);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.element.remove();
  }
}

/** Root manifests open by hex id; named sites by naddr (survives republish). */
function NsiteCardRoute(event: NostrEvent): string {
  if (event.kind === NSITE_NAMED_KIND) {
    const dTag = getTag(event.tags, 'd') || '';
    const naddr = encodeNaddr({
      kind: event.kind,
      pubkey: event.pubkey,
      identifier: dTag,
      relays: [],
    });
    return `/note/${naddr}`;
  }
  return `/note/${event.id}`;
}
