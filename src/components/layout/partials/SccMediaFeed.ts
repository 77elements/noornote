import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { getAllFollowedPubkeys } from '../../../lists/follows';
import { fetchEvents } from '../../../lists/relays';
import { PictureNoteProcessor } from '../../ui/note-processing/PictureNoteProcessor';
import { VideoNoteProcessor } from '../../ui/note-processing/VideoNoteProcessor';
import { UserProfileService } from '../../../services/UserProfileService';
import { Router } from '../../../services/Router';
import { InfiniteScroll } from '../../ui/InfiniteScroll';
import { hexToNpub } from '../../../helpers/nip19';
import { formatTimestamp } from '../../../helpers/formatTimestamp';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';
import type { MediaContent } from '../../../helpers/renderMediaContent';

const BATCH_SIZE = 12;

interface MediaItem {
  event: NostrEvent;
  media: MediaContent;
  title?: string | undefined;
}

export class SccMediaFeed {
  private container: HTMLElement;
  private gridEl: HTMLElement;
  private infiniteScroll: InfiniteScroll;
  private userProfileService: UserProfileService;
  private router: Router;
  private seenIds = new Set<string>();
  private oldestTimestamp = Math.floor(Date.now() / 1000);
  private isLoading = false;
  private hasMore = true;

  constructor(container: HTMLElement) {
    this.container = container;
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();

    this.gridEl = document.createElement('div');
    this.gridEl.className = 'media-feed';
    this.container.appendChild(this.gridEl);

    this.infiniteScroll = new InfiniteScroll(
      () => this.loadMore(),
      { loadingMessage: 'Loading media...', rootMargin: '400px' }
    );

    this.loadInitial();
  }

  private async loadInitial(): Promise<void> {
    const follows = getAllFollowedPubkeys();
    if (follows.length === 0) {
      this.gridEl.innerHTML = '<p class="media-feed__empty">Follow users to see their media here.</p>';
      return;
    }

    this.gridEl.innerHTML = '<p class="pulsate">Loading media...</p>';

    const items = await this.fetchMedia(follows);
    this.gridEl.innerHTML = '';

    if (items.length === 0) {
      this.gridEl.innerHTML = '<p class="media-feed__empty">No media from your follows yet.</p>';
      return;
    }

    const masonryContainer = document.createElement('div');
    masonryContainer.className = 'media-feed__masonry';
    this.gridEl.appendChild(masonryContainer);

    this.renderItems(masonryContainer, items);
    this.infiniteScroll.observe(this.gridEl);

    if (items.length < BATCH_SIZE) {
      this.hasMore = false;
      this.infiniteScroll.disconnect();
    }
  }

  private async loadMore(): Promise<void> {
    if (this.isLoading || !this.hasMore) return;
    this.isLoading = true;
    this.infiniteScroll.showLoading();

    try {
      const follows = getAllFollowedPubkeys();
      const items = await this.fetchMedia(follows);

      if (items.length === 0) {
        this.hasMore = false;
        this.infiniteScroll.disconnect();
      } else {
        const masonry = this.gridEl.querySelector('.media-feed__masonry');
        if (masonry) this.renderItems(masonry as HTMLElement, items);

        if (items.length < BATCH_SIZE) {
          this.hasMore = false;
          this.infiniteScroll.disconnect();
        } else {
          this.infiniteScroll.hideLoading();
        }
      }
    } catch {
      this.infiniteScroll.hideLoading();
    } finally {
      this.isLoading = false;
    }
  }

  private async fetchMedia(authors: string[]): Promise<MediaItem[]> {
    const batchSize = 150;
    const allEvents: NostrEvent[] = [];

    for (let i = 0; i < authors.length; i += batchSize) {
      const batch = authors.slice(i, i + batchSize);
      const events = await fetchEvents([{
        kinds: [20, 21, 22],
        authors: batch,
        until: this.oldestTimestamp,
        limit: BATCH_SIZE + 10
      }], 8000);
      allEvents.push(...events);
    }

    const sorted = allEvents
      .filter(e => e.id && !this.seenIds.has(e.id))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    const items: MediaItem[] = [];
    for (const event of sorted) {
      if (items.length >= BATCH_SIZE) break;

      const media = this.extractFirstMedia(event);
      if (!media) continue;

      this.seenIds.add(event.id!);
      const title = getTag(event.tags, 'title') || undefined;
      items.push({ event, media, title });
    }

    if (items.length > 0) {
      const last = items[items.length - 1]!;
      this.oldestTimestamp = (last.event.created_at ?? this.oldestTimestamp) - 1;
    }

    return items;
  }

  private extractFirstMedia(event: NostrEvent): MediaContent | null {
    if (event.kind === 20) {
      const images = PictureNoteProcessor.extractImagesFromTags(event.tags);
      return images[0] ?? null;
    }
    if (event.kind === 21 || event.kind === 22) {
      const videos = VideoNoteProcessor.extractVideoFromTags(event.tags);
      return videos[0] ?? null;
    }
    return null;
  }

  private renderItems(container: HTMLElement, items: MediaItem[]): void {
    for (const item of items) {
      container.appendChild(this.createTile(item));
    }
  }

  private createTile(item: MediaItem): HTMLElement {
    const tile = document.createElement('div');
    tile.className = 'media-feed__tile';

    const isVideo = item.media.type === 'video';

    let mediaHtml: string;
    if (isVideo) {
      const posterAttr = item.media.thumbnail ? ` poster="${escapeHtmlAttr(item.media.thumbnail)}"` : '';
      mediaHtml = `
        <video src="${escapeHtmlAttr(item.media.url)}"${posterAttr} preload="none" muted></video>
        <div class="media-feed__play-icon"><svg width="24" height="24"><use href="#icon-play"/></svg></div>
      `;
    } else {
      mediaHtml = `<img src="${escapeHtmlAttr(item.media.url)}" alt="${escapeHtmlAttr(item.media.alt || '')}" loading="lazy" />`;
    }

    tile.innerHTML = `
      <div class="media-feed__tile-media">
        ${mediaHtml}
      </div>
      <div class="media-feed__tile-info">
        ${item.title ? `<span class="media-feed__tile-title">${escapeHtml(item.title)}</span>` : ''}
        <span class="media-feed__tile-author" data-pubkey="${item.event.pubkey}">...</span>
        <span class="media-feed__tile-time">${formatTimestamp(item.event.created_at || 0)}</span>
      </div>
    `;

    tile.addEventListener('click', () => {
      this.router.navigate(`/note/${item.event.id}`);
    });

    this.loadAuthor(tile, item.event.pubkey);

    return tile;
  }

  private async loadAuthor(tile: HTMLElement, pubkey: string): Promise<void> {
    const el = tile.querySelector('.media-feed__tile-author');
    if (!el) return;

    try {
      const profile = await this.userProfileService.getUserProfile(pubkey);
      const fallback = (hexToNpub(pubkey) ?? pubkey).slice(0, 12) + '...';
      el.textContent = profile?.name || profile?.display_name || fallback;
    } catch {
      el.textContent = (hexToNpub(pubkey) ?? pubkey).slice(0, 12) + '...';
    }
  }

  public destroy(): void {
    this.infiniteScroll.destroy();
    this.container.innerHTML = '';
    this.seenIds.clear();
  }
}
