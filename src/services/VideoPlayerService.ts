/**
 * VideoPlayerService
 * Initializes Plyr video players for note videos
 * Generates persistent poster frames to prevent disappearing thumbnails
 */

import Plyr from 'plyr';

export class VideoPlayerService {
  private static instance: VideoPlayerService | null = null;
  private players: Map<HTMLVideoElement, Plyr> = new Map();

  private constructor() {}

  public static getInstance(): VideoPlayerService {
    if (!VideoPlayerService.instance) {
      VideoPlayerService.instance = new VideoPlayerService();
    }
    return VideoPlayerService.instance;
  }

  /**
   * Generate poster frame from video's first frame
   * Uses canvas to capture frame and set as permanent poster attribute
   */
  private generatePosterForVideo(video: HTMLVideoElement): void {
    // Skip if poster already exists
    if (video.poster) return;

    const handleLoadedData = () => {
      // Ensure video has loaded enough data
      if (video.readyState >= 2) { // HAVE_CURRENT_DATA or higher
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const ctx = canvas.getContext('2d');
        if (ctx && canvas.width > 0 && canvas.height > 0) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const posterUrl = canvas.toDataURL('image/jpeg', 0.8);
          video.poster = posterUrl;
        }
      }

      video.removeEventListener('loadeddata', handleLoadedData);
    };

    video.addEventListener('loadeddata', handleLoadedData);

    // Trigger load if not already loaded
    if (video.readyState < 2) {
      video.load();
    } else {
      handleLoadedData();
    }
  }

  /**
   * Initialize Plyr for all videos in a container
   */
  public initializeForContainer(container: HTMLElement): void {
    const videos = container.querySelectorAll<HTMLVideoElement>('video.note-video');
    videos.forEach(video => {
      if (this.players.has(video)) return; // Already initialized

      const player = new Plyr(video, {
        controls: ['play', 'progress', 'current-time', 'mute', 'volume', 'fullscreen'],
        hideControls: true,
        resetOnEnd: true
      });

      this.players.set(video, player);

      // Generate persistent poster frame
      this.generatePosterForVideo(video);
    });
  }

  /**
   * Cleanup Plyr instances for a container
   */
  public cleanupForContainer(container: HTMLElement): void {
    const videos = container.querySelectorAll<HTMLVideoElement>('video.note-video');
    videos.forEach(video => {
      const player = this.players.get(video);
      if (player) {
        player.destroy();
        this.players.delete(video);
      }
    });
  }
}

export function getVideoPlayerService(): VideoPlayerService {
  return VideoPlayerService.getInstance();
}
