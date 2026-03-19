/**
 * ProfileVideosCarousel Component
 * Displays a user's video notes (NIP-71, kind:21/22) in a horizontal carousel
 * with video thumbnail previews and titles.
 *
 * @component ProfileVideosCarousel
 * @used-by ProfileView
 */

import { NostrTransport } from '../../services/transport/NostrTransport';
import { Router } from '../../services/Router';
import { VideoNoteProcessor } from '../ui/note-processing/VideoNoteProcessor';
import { createScrollCarousel, type ScrollCarouselInstance } from '../../helpers/CarouselHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

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
  private transport: NostrTransport;
  private carousel: ScrollCarouselInstance | null = null;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
    this.transport = NostrTransport.getInstance();
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
    const relays = this.transport.getReadRelays();

    try {
      const events = await this.transport.fetch(relays, [{
        kinds: [21, 22],
        authors: [this.pubkey],
        limit: 20
      }], 8000, false, 'VideosCarousel');

      events.sort((a, b) => b.created_at - a.created_at);

      this.videos = events
        .map(event => {
          const media = VideoNoteProcessor.extractVideoFromTags(event.tags);
          const firstVideo = media[0];
          if (!firstVideo) return null;

          return {
            event,
            title: event.tags.find(t => t[0] === 'title')?.[1] || '',
            thumbnail: firstVideo.thumbnail || '',
            videoUrl: firstVideo.url
          };
        })
        .filter((v): v is VideoCardData => v !== null);

      // Log video URLs for debugging
      const { diagLog } = await import('../../services/DiagnosticLogger');
      diagLog('system', 'VideosCarousel: loaded', {
        count: this.videos.length,
        videos: this.videos.map(v => ({ title: v.title?.slice(0, 30), thumbnail: v.thumbnail || 'none', videoUrl: v.videoUrl?.slice(0, 60) }))
      });
    } catch (error) {
      console.error('[ProfileVideosCarousel] Failed to fetch videos:', error);
      this.videos = [];
    }
  }

  private renderCarousel(): void {
    const cards = this.videos.map(video => {
      const eventId = video.event.id || '';
      const posterAttr = video.thumbnail ? ` poster="${this.escapeHtml(video.thumbnail)}"` : '';

      return {
        html: `
          <div class="profile-videos-carousel__card-thumb">
            <video src="${this.escapeHtml(video.videoUrl)}"${posterAttr} preload="metadata" muted></video>
            <div class="profile-videos-carousel__play-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
          </div>
          ${video.title ? `<div class="profile-videos-carousel__card-title">${this.escapeHtml(video.title)}</div>` : ''}
        `,
        data: { noteid: eventId }
      };
    });

    this.carousel = createScrollCarousel({
      title: 'Videos',
      cards,
      onCardClick: (_index, data) => {
        if (data.noteid) {
          Router.getInstance().navigate(`/note/${data.noteid}`);
        }
      }
    });

    this.element.appendChild(this.carousel.element);

    // Force first-frame render by seeking to 0.5s after mount
    const videos = this.element.querySelectorAll('video');
    videos.forEach(video => {
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = 0.5;
      }, { once: true });
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.carousel) this.carousel.destroy();
    this.element.remove();
  }
}
