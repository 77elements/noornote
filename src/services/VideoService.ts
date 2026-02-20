/**
 * VideoService - Video Event Publishing Service
 * Handles creation and publishing of Kind 21 (landscape) and Kind 22 (portrait) video events
 *
 * NIP-71: https://github.com/nostr-protocol/nips/blob/master/71.md
 * NIP-92: https://github.com/nostr-protocol/nips/blob/master/92.md (imeta tags)
 */

import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from '../components/system/SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { encodeNevent } from './NostrToolsAdapter';

export interface VideoOptions {
  /** Uploaded video URL */
  videoUrl: string;
  /** Video MIME type (e.g. video/mp4) */
  mimeType: string;
  /** Video dimensions for kind detection and imeta */
  dimensions?: { width: number; height: number };
  /** Thumbnail/cover image URL */
  thumbnailUrl?: string;
  /** Video title (optional) */
  title?: string;
  /** Description text (becomes event content) */
  content: string;
  /** Topic tags (t-tags) */
  topics?: string[];
  /** Target relays to publish to */
  relays: string[];
  /** Override auto-detected kind (21=landscape, 22=portrait) */
  kindOverride?: 21 | 22;
}

export class VideoService {
  private static instance: VideoService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): VideoService {
    if (!VideoService.instance) {
      VideoService.instance = new VideoService();
    }
    return VideoService.instance;
  }

  /**
   * Publish a video event (Kind 21 or 22)
   * @returns nevent on success, null on failure
   */
  public async publishVideo(options: VideoOptions): Promise<string | null> {
    const { videoUrl, mimeType, dimensions, thumbnailUrl, title, content, topics, relays, kindOverride } = options;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('VideoService', 'Cannot publish video: User not authenticated');
      return null;
    }

    if (!videoUrl?.trim()) {
      this.systemLogger.error('VideoService', 'Cannot publish video: No video URL');
      ToastService.show('Please upload a video first', 'error');
      return null;
    }

    if (!relays?.length) {
      this.systemLogger.error('VideoService', 'Cannot publish video: No relays specified');
      ToastService.show('Please select at least one relay', 'error');
      return null;
    }

    try {
      // Determine kind: override > dimension-based > default landscape
      let kind: 21 | 22;
      if (kindOverride) {
        kind = kindOverride;
      } else if (dimensions) {
        kind = dimensions.width >= dimensions.height ? 21 : 22;
      } else {
        kind = 21;
      }

      const now = Math.floor(Date.now() / 1000);

      // Build imeta tag (NIP-92)
      const imetaParts: string[] = [
        'url ' + videoUrl.trim(),
        'm ' + mimeType.trim()
      ];
      if (dimensions) {
        imetaParts.push('dim ' + dimensions.width + 'x' + dimensions.height);
      }
      if (thumbnailUrl?.trim()) {
        imetaParts.push('image ' + thumbnailUrl.trim());
      }

      const tags: string[][] = [
        ['imeta', ...imetaParts]
      ];

      if (title?.trim()) {
        tags.push(['title', title.trim()]);
      }

      if (topics) {
        for (const topic of topics) {
          const trimmed = topic.trim();
          if (trimmed) {
            tags.push(['t', trimmed.toLowerCase()]);
          }
        }
      }

      const unsignedEvent = {
        kind,
        created_at: now,
        tags,
        content: content.trim(),
        pubkey: currentUser.pubkey
      };

      const signedEvent = await this.authService.signEvent(unsignedEvent);
      if (!signedEvent) {
        this.systemLogger.error('VideoService', 'Failed to sign video event');
        return null;
      }

      await this.transport.publish(relays, signedEvent);

      const kindLabel = kind === 21 ? 'Landscape' : 'Portrait';
      this.systemLogger.info(
        'VideoService',
        `${kindLabel} video published to ${relays.length} relay(s): ${signedEvent.id?.slice(0, 8)}...`
      );

      ToastService.show('Video published successfully!', 'success');

      return encodeNevent(signedEvent.id!, relays.slice(0, 2), currentUser.pubkey);
    } catch (error) {
      ErrorService.handle(
        error,
        'VideoService.publishVideo',
        true,
        'Failed to publish video. Please try again.'
      );
      return null;
    }
  }
}
