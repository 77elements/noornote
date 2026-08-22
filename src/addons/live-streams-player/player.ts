/**
 * Live Streams Player — mounts an HLS <video> into a container.
 *
 * Only loaded when the addon is enabled and a live stream card
 * wants to upgrade itself to an inline player.
 *
 * Uses the browser's native HLS support when available (Safari),
 * otherwise dynamically imports hls.js.
 */

export interface MountOptions {
  /** The streaming URL from the kind 30311 event's `streaming` tag */
  streamUrl: string;
  /** Optional poster image (cover art from the `image` tag) */
  poster?: string;
}

export interface PlayerHandle {
  destroy(): void;
}

const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegURL',
];

export async function mountPlayer(
  container: HTMLElement,
  opts: MountOptions
): Promise<PlayerHandle> {
  container.innerHTML = '';

  const video = document.createElement('video');
  video.className = 'live-stream-player__video';
  video.controls = true;
  video.autoplay = false;
  video.playsInline = true;
  if (opts.poster) video.poster = opts.poster;
  container.appendChild(video);

  const isHls = opts.streamUrl.includes('.m3u8');
  const nativeHls = HLS_CONTENT_TYPES.some(t => video.canPlayType(t));

  // Safari / iOS: native HLS
  if (!isHls || nativeHls) {
    video.src = opts.streamUrl;
    return {
      destroy() {
        try {
          video.pause();
        } catch {}
        video.removeAttribute('src');
        video.load();
        container.innerHTML = '';
      },
    };
  }

  // Chromium / Firefox: hls.js
  const { default: Hls } = await import('hls.js');

  if (!Hls.isSupported()) {
    // Last resort: try native src anyway
    video.src = opts.streamUrl;
    return {
      destroy() {
        try {
          video.pause();
        } catch {}
        video.removeAttribute('src');
        video.load();
        container.innerHTML = '';
      },
    };
  }

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: true,
  });
  hls.loadSource(opts.streamUrl);
  hls.attachMedia(video);

  return {
    destroy() {
      try {
        hls.destroy();
      } catch {}
      try {
        video.pause();
      } catch {}
      video.removeAttribute('src');
      video.load();
      container.innerHTML = '';
    },
  };
}
