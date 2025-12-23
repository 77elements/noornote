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

export interface MediaContent {
  type: 'image' | 'video' | 'audio';
  url: string;
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
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Render single media item inline (without grid wrapper)
 * Used for inline media placement where placeholders are
 */
export function renderSingleMedia(item: MediaContent, index: number, isNSFW = false): string {
  switch (item.type) {
    case 'image':
      const imageClass = isNSFW ? 'note-image note-image--clickable note-image--nsfw-blur' : 'note-image note-image--clickable';
      return `<img src="${item.url}" alt="${item.alt || ''}" class="${imageClass}" loading="lazy" data-image-index="${index}">`;
    case 'video':
      // Check if YouTube
      const videoId = getYouTubeVideoId(item.url);
      if (videoId) {
        return `<div class="youtube-embed-wrapper"><div class="youtube-embed"><iframe src="https://www.youtube.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div><a href="https://www.youtube.com/watch?v=${videoId}" class="youtube-external-link">Watch on YouTube</a></div>`;
      }
      const posterAttr = item.thumbnail ? ` data-poster="${item.thumbnail}"` : '';
      return `<video src="${item.url}"${posterAttr} controls class="note-video" preload="metadata"></video>`;
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

  const mediaHtml = mediaArray.map((item, index) => {
    switch (item.type) {
      case 'image':
        return `<img src="${item.url}" alt="${item.alt || ''}" class="note-image note-image--clickable" loading="lazy" data-image-index="${index}">`;
      case 'video':
        const ytId = getYouTubeVideoId(item.url);
        if (ytId) {
          return `<div class="youtube-embed-wrapper"><div class="youtube-embed"><iframe src="https://www.youtube.com/embed/${ytId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div><a href="https://www.youtube.com/watch?v=${ytId}" class="youtube-external-link">Watch on YouTube</a></div>`;
        }
        const posterAttr = item.thumbnail ? ` data-poster="${item.thumbnail}"` : '';
        return `<video src="${item.url}"${posterAttr} controls class="note-video" preload="metadata"></video>`;
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
  let dataAttr = imageUrls.length > 0 ? ` data-image-urls="${encodeURIComponent(JSON.stringify(imageUrls))}"` : '';
  if (eventId) dataAttr += ` data-event-id="${eventId}"`;
  if (authorPubkey) dataAttr += ` data-author-pubkey="${authorPubkey}"`;
  if (isNSFW) dataAttr += ` data-is-nsfw="true"`;

  return `<div class="${wrapper}"${dataAttr}>${mediaHtml}</div>`;
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
  let dataAttr = imageUrls.length > 0 ? ` data-image-urls="${encodeURIComponent(JSON.stringify(imageUrls))}"` : '';
  if (eventId) dataAttr += ` data-event-id="${eventId}"`;
  if (authorPubkey) dataAttr += ` data-author-pubkey="${authorPubkey}"`;
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
    const index = parseInt(match[1]);
    const matchStart = match.index!;
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
      const index = group[0];
      const placeholder = `__MEDIA_${index}__`;
      const mediaHtml = renderSingleMedia(media[index], index, isNSFW);
      const wrappedMedia = `<div class="note-media-inline"${dataAttr}>${mediaHtml}</div>`;
      result = result.replace(placeholder, wrappedMedia);
    } else {
      // Multiple consecutive media - render as grid
      const groupMedia = group.map(i => media[i]);
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
        renderSingleMedia(item, group[idx], isNSFW)
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

  return result;
}
