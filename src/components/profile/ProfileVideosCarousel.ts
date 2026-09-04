/**
 * ProfileVideosCarousel Component
 * Displays a user's video notes (NIP-71, kind:21/22) in a horizontal carousel
 * with video thumbnail previews and titles.
 *
 * @component ProfileVideosCarousel
 * @used-by ProfileView
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import { Router } from '../../services/Router';
import { VideoNoteProcessor } from '../ui/note-processing/VideoNoteProcessor';
import { type ScrollCarouselInstance } from '../../helpers/CarouselHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { getTag } from '../../helpers/tagUtils';

interface VideoCardData {
  event: NostrEvent;
  title: string;
  thumbnail: string;
  videoUrl: string;
}

export class ProfileVideosCarousel {
  private element: HTMLElement;
  private pubkey: string;
  private videos: VideoCardData[] = [];
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
  private carousel: ScrollCarouselInstance | null = null;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
    this.element = document.createElement('div');
    this.element.className = 'profile-videos-carousel';
  }

  /**
   * Fetch videos and render the carousel
   */
  public async render(): Promise<HTMLElement> {
    await this.fetchVideos();

    if (this.videos.length === 0) {
      this.element.style.display = 'none';
      return this.element;
    }

    this.renderCarousel();
    return this.element;
  }

  private async fetchVideos(): Promise<void> {
    try {
      // Shared fetch (read + outbound relays) via the profile module;
      // reuses the same cached round-trip as the articles/listings carousels.
      const profileApi = await this.ensureProfileApi();
      const content = await profileApi.fetchCarouselContent(this.pubkey);
      const events = [...content.videos];

      events.sort((a, b) => b.created_at - a.created_at);

      this.videos = events
        .map(event => {
          const media = VideoNoteProcessor.extractVideoFromTags(event.tags);
          const firstVideo = media[0];
          if (!firstVideo) return null;

          return {
            event,
            title: getTag(event.tags, 'title'),
            thumbnail: firstVideo.thumbnail || '',
            videoUrl: firstVideo.url,
          };
        })
        .filter((v): v is VideoCardData => v !== null);

      // Log video URLs for debugging
      const { diagLog } = await import('../../services/DiagnosticLogger');
      diagLog('system', 'VideosCarousel: loaded', {
        count: this.videos.length,
        videos: this.videos.map(v => ({
          title: v.title?.slice(0, 30),
          thumbnail: v.thumbnail || 'none',
          videoUrl: v.videoUrl?.slice(0, 60),
        })),
      });
    } catch (error) {
      console.error('[ProfileVideosCarousel] Failed to fetch videos:', error);
      this.videos = [];
    }
  }

  private renderCarousel(): void {
    // Videos render as a 2-column masonry (shared .media-feed layout with the
    // scc Media feed), not a horizontal carousel.
    const masonry = document.createElement('div');
    masonry.className = 'media-feed__masonry';

    masonry.innerHTML = this.videos
      .map(video => {
        const eventId = video.event.id || '';
        const posterAttr = video.thumbnail
          ? ` poster="${escapeHtmlAttr(video.thumbnail)}"`
          : '';
        return `
        <div class="media-feed__tile" data-noteid="${escapeHtmlAttr(eventId)}">
          <div class="media-feed__tile-media">
            <video src="${escapeHtmlAttr(video.videoUrl)}"${posterAttr} preload="none" muted></video>
            <div class="media-feed__play-icon"><svg width="24" height="24"><use href="#icon-play"/></svg></div>
          </div>
          ${video.title ? `<div class="media-feed__tile-info"><span class="media-feed__tile-title">${escapeHtml(video.title)}</span></div>` : ''}
        </div>
      `;
      })
      .join('');

    masonry.querySelectorAll('.media-feed__tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const id = (tile as HTMLElement).dataset.noteid;
        if (id) Router.getInstance().navigate(`/note/${id}`);
      });
    });

    this.element.appendChild(masonry);
    // Video thumbnail seek handled by global MutationObserver (startVideoThumbnailObserver)
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.carousel) this.carousel.destroy();
    this.element.remove();
  }
}
