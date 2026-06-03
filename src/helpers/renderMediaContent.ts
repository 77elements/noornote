/**
 * Render media content (images, videos) to HTML
 * Single purpose: MediaContent[] → HTML string
 *
 * @param media - Array of MediaContent objects
 * @returns HTML string with rendered media elements
 *
 * @example
 * renderMediaContent([{ type: 'image', url: 'https://example.com/img.jpg' }])
 * // => '<div class="note-media"><img src="..." class="note-image" loading="lazy"></div>'
 */

import { escapeHtmlAttr } from './escapeHtml';
import { lightboxImageHtml, lightboxContainerDataUrlsAttr } from './lightboxImages';
import { isDataSaverEnabled } from '../services/DataSaverService';

/**
 * Render a tap-to-load placeholder (Data Saver mode).
 * On tap, replaced by actual media element via initMediaPlaceholderHandler().
 */
function renderPlaceholder(type: string, url: string, index: number, alt?: string, poster?: string): string {
  const icon = type === 'video' ? '▶' : type === 'audio' ? '♪' : '🖼';
  const label = type === 'video' ? 'Tap to load video' : type === 'audio' ? 'Tap to load audio' : 'Tap to load image';
  return `<div class="media-placeholder media-placeholder--${type}" data-src="${escapeHtmlAttr(url)}" data-type="${type}" data-index="${index}"${poster ? ` data-poster="${escapeHtmlAttr(poster)}"` : ''}${alt ? ` data-alt="${escapeHtmlAttr(alt)}"` : ''}><span class="media-placeholder__icon">${icon}</span><span class="media-placeholder__label">${label}</span></div>`;
}

/**
 * Render a video as a lightweight wrapper instead of a live <video> element.
 *
 * A real <video> element (even preload="none") instantiates a WebMediaPlayer in
 * the renderer (~2MB native each). In an unbounded feed every video note kept one
 * mounted, so dozens of off-screen videos piled up media/gpu memory. Instead we emit
 * a placeholder wrapper that reserves the video's height and shows the imeta poster
 * (when present); the global observer (getWrapObserver) mounts a real <video> only
 * while the wrapper is near the viewport and unmounts it again once it scrolls far
 * away, so media memory is bound to what's actually on screen. Height is reserved via
 * aspect-ratio so swapping the inner element never shifts the scroll anchor.
 */
function renderVideo(item: MediaContent, index: number): string {
  const src = escapeHtmlAttr(item.url);
  const poster = item.thumbnail ? escapeHtmlAttr(item.thumbnail) : '';
  const dim = item.dimensions;
  const hasDim = !!(dim && dim.width && dim.height);
  const styleAttr = hasDim ? ` style="aspect-ratio:${dim!.width}/${dim!.height}"` : '';
  const dimAttr = hasDim ? ` data-dim="${dim!.width}x${dim!.height}"` : '';
  const posterData = poster ? ` data-poster="${poster}"` : '';
  const posterImg = poster ? `<img class="note-video-wrap__poster" src="${poster}" alt="" loading="lazy">` : '';
  return `<div class="note-video-wrap" data-video-src="${src}" data-index="${index}"${posterData}${dimAttr}${styleAttr}>${posterImg}<span class="note-video-wrap__play" aria-hidden="true">▶</span></div>`;
}

export interface MediaContent {
  type: 'image' | 'video' | 'audio';
  url: string;
  originalUrl?: string;
  alt?: string;
  thumbnail?: string;
  dimensions?: { width: number; height: number };
}

/**
 * Extract YouTube video ID from URL
 */
function getYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#]+)/,
    /youtube\.com\/live\/([^&\n?#]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

/**
 * Render single media item inline (without grid wrapper)
 * Used for inline media placement where placeholders are
 */
export function renderSingleMedia(item: MediaContent, index: number, isNSFW = false): string {
  if (isDataSaverEnabled()) return renderPlaceholder(item.type, item.url, index, item.alt, item.thumbnail);

  switch (item.type) {
    case 'image':
      return lightboxImageHtml(item.url, index, {
        ...(item.alt ? { alt: item.alt } : {}),
        ...(isNSFW ? { extraClasses: ['note-image--nsfw-blur'] } : {})
      });
    case 'video':
      // Check if YouTube
      const videoId = getYouTubeVideoId(item.url);
      if (videoId) {
        const safeId = escapeHtmlAttr(videoId);
        return `<div class="youtube-embed-wrapper"><div class="youtube-embed"><iframe src="https://www.youtube.com/embed/${safeId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div><a href="https://www.youtube.com/watch?v=${safeId}" class="youtube-external-link">Watch on YouTube</a></div>`;
      }
      return renderVideo(item, index);
    case 'audio':
      return `<audio src="${escapeHtmlAttr(item.url)}" controls preload="metadata" class="note-audio"></audio>`;
    default:
      return '';
  }
}

export interface RenderMediaOptions {
  media: MediaContent[];
  isNSFW?: boolean;
  eventId?: string;
  authorPubkey?: string;
}

export function renderMediaContent(media: MediaContent[] | RenderMediaOptions): string {
  // Support both old signature (array) and new signature (options object)
  const mediaArray = Array.isArray(media) ? media : media.media;
  const isNSFW = Array.isArray(media) ? false : (media.isNSFW || false);
  const eventId = Array.isArray(media) ? undefined : media.eventId;
  const authorPubkey = Array.isArray(media) ? undefined : media.authorPubkey;

  if (mediaArray.length === 0) return '';

  const dataSaver = isDataSaverEnabled();

  const mediaHtml = mediaArray.map((item, index) => {
    if (dataSaver) return renderPlaceholder(item.type, item.url, index, item.alt, item.thumbnail);

    switch (item.type) {
      case 'image':
        return lightboxImageHtml(item.url, index, item.alt ? { alt: item.alt } : undefined);
      case 'video':
        const ytId = getYouTubeVideoId(item.url);
        if (ytId) {
          const safeId = escapeHtmlAttr(ytId);
          return `<div class="youtube-embed-wrapper"><div class="youtube-embed"><iframe src="https://www.youtube.com/embed/${safeId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div><a href="https://www.youtube.com/watch?v=${safeId}" class="youtube-external-link">Watch on YouTube</a></div>`;
        }
        return renderVideo(item, index);
      case 'audio':
        return `<audio src="${escapeHtmlAttr(item.url)}" controls preload="metadata" class="note-audio"></audio>`;
      default:
        return '';
    }
  }).join('');

  // Determine grid modifier based on number of images
  const imageCount = mediaArray.filter(m => m.type === 'image').length;
  let gridModifier = '';
  if (imageCount === 2) {
    gridModifier = ' note-media--grid-2';
  } else if (imageCount === 3) {
    gridModifier = ' note-media--grid-3';
  } else if (imageCount === 4) {
    gridModifier = ' note-media--grid-2x2';
  } else if (imageCount >= 5) {
    gridModifier = ' note-media--grid-3-cols';
  }

  const wrapper = isNSFW ? `note-media nsfw-media${gridModifier}` : `note-media${gridModifier}`;
  const imageUrls = mediaArray.filter(m => m.type === 'image').map(m => m.url);

  // Build data attributes for ImageViewer context
  let dataAttr = imageUrls.length > 0 ? ` ${lightboxContainerDataUrlsAttr(imageUrls)}` : '';
  if (eventId) dataAttr += ` data-event-id="${escapeHtmlAttr(eventId)}"`;
  if (authorPubkey) dataAttr += ` data-author-pubkey="${escapeHtmlAttr(authorPubkey)}"`;
  if (isNSFW) dataAttr += ` data-is-nsfw="true"`;

  return `<div class="${wrapper}"${dataAttr}>${mediaHtml}</div>`;
}

/**
 * Lazily generate a raw <video>'s thumbnail by loading metadata + seeking to 0.5s.
 * Used ONLY for legacy raw <video> elements that are not wrapped in .note-video-wrap
 * (e.g. ProfileVideosCarousel). Called when the video nears the viewport.
 */
function initVideoThumb(el: HTMLVideoElement): void {
  if (el.dataset.thumbInit) return;
  el.dataset.thumbInit = '1';
  el.addEventListener('loadedmetadata', () => {
    el.currentTime = 0.5;
  }, { once: true });
  // With preload="none", we must trigger load manually
  if (el.preload === 'none' || el.readyState === 0) {
    el.preload = 'metadata';
    el.load();
  } else if (el.readyState >= 1) {
    el.currentTime = 0.5;
  }
}

// Legacy raw-<video> thumbnail loader: load a video's metadata/thumbnail only once it
// nears the viewport, so off-screen carousel videos stay undecoded.
let thumbVisibilityObserver: IntersectionObserver | null = null;

function getThumbVisibilityObserver(): IntersectionObserver {
  if (!thumbVisibilityObserver) {
    thumbVisibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const video = entry.target as HTMLVideoElement;
          thumbVisibilityObserver!.unobserve(video); // generate the thumbnail once
          initVideoThumb(video);
        }
      },
      { rootMargin: '300px' }
    );
  }
  return thumbVisibilityObserver;
}

// Mount a real <video> inside a .note-video-wrap, only while it is near the viewport.
function mountVideo(wrap: HTMLElement): void {
  if (wrap.querySelector('video')) return;
  const src = wrap.dataset.videoSrc;
  if (!src) return;
  const poster = wrap.dataset.poster;
  const video = document.createElement('video');
  video.src = src;
  video.controls = true;
  video.setAttribute('controlsList', 'nodownload');
  video.playsInline = true;
  video.preload = 'metadata';
  video.className = 'note-video';
  if (poster) video.poster = poster;
  video.addEventListener('loadedmetadata', () => {
    // Lock the wrapper's aspect-ratio from the real dimensions if we did not know
    // them upfront, so a later unmount/remount never changes the height.
    if (!wrap.dataset.dim && video.videoWidth > 0 && video.videoHeight > 0) {
      wrap.style.aspectRatio = `${video.videoWidth}/${video.videoHeight}`;
      wrap.dataset.dim = `${video.videoWidth}x${video.videoHeight}`;
    }
    // No imeta poster → seek slightly in to surface a non-black thumbnail frame.
    if (!poster) {
      try { video.currentTime = 0.5; } catch { /* seeking unsupported */ }
    }
  }, { once: true });
  wrap.appendChild(video);
  wrap.classList.add('note-video-wrap--active');
}

// Remove the <video> again once the wrapper scrolls far off-screen, freeing its
// WebMediaPlayer. A currently-playing video is left mounted so playback is not cut.
function unmountVideo(wrap: HTMLElement): void {
  const video = wrap.querySelector('video') as HTMLVideoElement | null;
  if (!video) return;
  if (!video.paused) return;
  try { video.pause(); } catch { /* ignore */ }
  video.removeAttribute('src');
  try { video.load(); } catch { /* ignore */ }
  video.remove();
  wrap.classList.remove('note-video-wrap--active');
}

let wrapObserver: IntersectionObserver | null = null;

function getWrapObserver(): IntersectionObserver {
  if (!wrapObserver) {
    wrapObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const wrap = entry.target as HTMLElement;
          if (entry.isIntersecting) mountVideo(wrap);
          else unmountVideo(wrap);
        }
      },
      { rootMargin: '300px' }
    );
  }
  return wrapObserver;
}

/**
 * Watch the DOM for inserted media and wire up viewport-driven video handling:
 * - `.note-video-wrap` (timeline/notes) → mount a real <video> only while on screen,
 *   unmount it again when it scrolls far away (bounds media memory to what's visible).
 * - raw `<video>` not inside a wrapper (e.g. ProfileVideosCarousel) → legacy seek-to-
 *   thumbnail when near the viewport.
 * Call once at app startup.
 */
export function startVideoThumbnailObserver(): void {
  const register = (root: HTMLElement) => {
    const wraps = (root.classList?.contains('note-video-wrap')
      ? [root]
      : Array.from(root.querySelectorAll('.note-video-wrap'))) as HTMLElement[];
    for (const wrap of wraps) {
      if (wrap.dataset.videoObserved) continue;
      wrap.dataset.videoObserved = '1';
      getWrapObserver().observe(wrap);
    }

    const videos = (root.tagName === 'VIDEO'
      ? [root]
      : Array.from(root.querySelectorAll('video'))) as HTMLVideoElement[];
    for (const video of videos) {
      if (video.closest('.note-video-wrap')) continue; // managed by the wrap observer
      if (video.dataset.thumbObserved) continue;
      video.dataset.thumbObserved = '1';
      getThumbVisibilityObserver().observe(video);
    }
  };

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) register(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Global tap-to-load handler for Data Saver placeholders.
 * Uses capture phase to fire BEFORE note-card click handlers (prevents SNV navigation).
 * Call once at app startup.
 */
export function initMediaPlaceholderHandler(): void {
  document.body.addEventListener('click', (e) => {
    const placeholder = (e.target as HTMLElement).closest('.media-placeholder') as HTMLElement;
    if (!placeholder) return;

    const src = placeholder.dataset.src;
    const type = placeholder.dataset.type;
    if (!src || !type) return;

    let el: HTMLElement;
    if (type === 'image') {
      const img = document.createElement('img');
      img.src = src;
      img.alt = placeholder.dataset.alt || '';
      img.className = 'note-image note-image--clickable';
      img.loading = 'lazy';
      img.dataset.imageIndex = placeholder.dataset.index || '0';
      el = img;
    } else if (type === 'video') {
      const video = document.createElement('video');
      video.src = src;
      video.controls = true;
      video.className = 'note-video';
      video.preload = 'metadata';
      if (placeholder.dataset.poster) video.poster = placeholder.dataset.poster;
      el = video;
    } else if (type === 'audio') {
      const audio = document.createElement('audio');
      audio.src = src;
      audio.controls = true;
      audio.preload = 'metadata';
      audio.className = 'note-audio';
      el = audio;
    } else {
      return;
    }

    placeholder.replaceWith(el);
  });
}

/**
 * Replace media placeholders in HTML with actual media elements
 * Placeholders format: __MEDIA_0__, __MEDIA_1__, etc.
 *
 * Smart grouping: Consecutive image placeholders are rendered as grid
 */
export function replaceMediaPlaceholders(
  html: string,
  media: MediaContent[],
  isNSFW = false,
  eventId?: string,
  authorPubkey?: string
): string {
  let result = html;

  // Collect all image URLs for data attribute (for ImageViewer gallery)
  const imageUrls = media.filter(m => m.type === 'image').map(m => m.url);
  let dataAttr = imageUrls.length > 0 ? ` ${lightboxContainerDataUrlsAttr(imageUrls)}` : '';
  if (eventId) dataAttr += ` data-event-id="${escapeHtmlAttr(eventId)}"`;
  if (authorPubkey) dataAttr += ` data-author-pubkey="${escapeHtmlAttr(authorPubkey)}"`;
  if (isNSFW) dataAttr += ` data-is-nsfw="true"`;

  // Find groups of consecutive media placeholders
  const placeholderPattern = /__MEDIA_(\d+)__/g;
  const matches = [...html.matchAll(placeholderPattern)];

  if (matches.length === 0) return result;

  // Group consecutive placeholders
  const groups: number[][] = [];
  let currentGroup: number[] = [];
  let lastMatchEnd = 0;

  matches.forEach((match, _idx) => {
    const index = parseInt(match[1] ?? '0');
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;

    // Check if this placeholder is consecutive (only whitespace/newlines/br tags between)
    const textBetween = html.slice(lastMatchEnd, matchStart);
    // Remove <br> tags and check if anything meaningful remains
    const textWithoutBr = textBetween.replace(/<br\s*\/?>/gi, '');
    const hasTextBetween = textWithoutBr.trim().length > 0;

    if (currentGroup.length === 0 || !hasTextBetween) {
      // First placeholder or consecutive (no text between)
      currentGroup.push(index);
    } else {
      // Non-consecutive - save current group and start new one
      if (currentGroup.length > 0) {
        groups.push([...currentGroup]);
      }
      currentGroup = [index];
    }

    lastMatchEnd = matchEnd;
  });

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // Replace groups
  groups.forEach(group => {
    if (group.length === 1) {
      // Single media - render inline
      const index = group[0]!;
      const mediaItem = media[index];
      if (!mediaItem) return;
      const placeholder = `__MEDIA_${index}__`;
      const mediaHtml = renderSingleMedia(mediaItem, index, isNSFW);
      const wrappedMedia = `<div class="note-media"${dataAttr}>${mediaHtml}</div>`;
      result = result.replace(placeholder, wrappedMedia);
    } else {
      // Multiple consecutive media - render as grid
      const groupMedia = group.map(i => media[i]).filter((m): m is MediaContent => m !== undefined);
      const imageCount = groupMedia.filter(m => m.type === 'image').length;

      // Determine grid modifier
      let gridModifier = '';
      if (imageCount === 2) {
        gridModifier = ' note-media--grid-2';
      } else if (imageCount === 3) {
        gridModifier = ' note-media--grid-3';
      } else if (imageCount === 4) {
        gridModifier = ' note-media--grid-2x2';
      } else if (imageCount >= 5) {
        gridModifier = ' note-media--grid-3-cols';
      }

      const mediaHtml = groupMedia.map((item, idx) =>
        renderSingleMedia(item, group[idx] ?? idx, isNSFW)
      ).join('');

      const wrapper = isNSFW ? `note-media nsfw-media${gridModifier}` : `note-media${gridModifier}`;
      const gridHtml = `<div class="${wrapper}"${dataAttr}>${mediaHtml}</div>`;

      // Build regex to match all placeholders in this group with <br> tags between them
      // e.g. __MEDIA_0__<br>__MEDIA_1__<br>__MEDIA_2__
      const placeholderRegexParts = group.map(index => `__MEDIA_${index}__`);
      const groupPattern = placeholderRegexParts.join('(?:<br\\s*/?>|\\s)*');
      const groupRegex = new RegExp(groupPattern, 'g');

      result = result.replace(groupRegex, gridHtml);
    }
  });

  // Collapse consecutive <br> tags immediately before a media block to a single <br>
  result = result.replace(/(?:<br\s*\/?>\s*){2,}(<div class="note-media)/gi, '<br>$1');

  return result;
}
