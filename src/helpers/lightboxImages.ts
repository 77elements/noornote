/**
 * Helpers for the global lightbox contract (`ImageClickHandler` in
 * `src/services/ImageClickHandler.ts`).
 *
 * The global click handler opens the lightbox when:
 *   1. The clicked target carries `class="note-image--clickable"` plus
 *      `data-image-index="N"`.
 *   2. The wrapping `.note-media` container carries
 *      `data-image-urls="<URI-encoded JSON array of urls>"`.
 *
 * If either side is missing, the handler bails silently. These helpers
 * keep both halves consistent across all HTML-string render paths
 * (timeline media, gallery rendering).
 *
 * The DOM-based path (`upgradeArticleImages.ts`) walks already-rendered
 * elements and writes the same attributes there — it does not use these
 * helpers but follows the same contract.
 */

import { escapeHtmlAttr } from './escapeHtml';

/**
 * Single `<img>` tag, classed and indexed, ready to drop inside a
 * `.note-media` container that carries the matching `data-image-urls`
 * attribute (use `lightboxContainerDataUrlsAttr` for that).
 *
 * @param url       Image URL.
 * @param index     0-based position in the gallery; passed back to the
 *                  lightbox as `data-image-index` so it knows which
 *                  image to open first.
 * @param opts.alt  Optional alt text.
 * @param opts.extraClasses  Additional classes appended after the two
 *                  required classes (`note-image note-image--clickable`).
 *                  Used by callers that add `note-image--nsfw-blur` etc.
 */
export function lightboxImageHtml(
  url: string,
  index: number,
  opts?: { alt?: string; extraClasses?: string[] }
): string {
  const classes = [
    'note-image',
    'note-image--clickable',
    ...(opts?.extraClasses ?? []),
  ].join(' ');
  const alt = escapeHtmlAttr(opts?.alt ?? '');
  return `<img src="${escapeHtmlAttr(url)}" alt="${alt}" loading="lazy" class="${classes}" data-image-index="${index}" />`;
}

/**
 * `data-image-urls="..."` attribute string for the `.note-media` container.
 * Order must match the `data-image-index` values used on the inner imgs.
 */
export function lightboxContainerDataUrlsAttr(urls: string[]): string {
  return `data-image-urls="${encodeURIComponent(JSON.stringify(urls))}"`;
}

export interface LightboxImagesHtml {
  /** Concatenated `<img>` tags. */
  imagesHtml: string;
  /** `data-image-urls="..."` attribute for the `.note-media` container. */
  containerDataAttr: string;
}

/**
 * Convenience wrapper that builds both halves at once for the common
 * "gallery of N URLs, all clickable, all in the same lightbox" case.
 *
 * @param opts.alts  Optional per-image alt text, indexed alongside `urls`.
 *                   Falsy/missing entries default to empty string.
 */
export function buildLightboxImagesHtml(
  urls: string[],
  opts?: { alts?: string[] }
): LightboxImagesHtml {
  const imagesHtml = urls
    .map((url, index) =>
      lightboxImageHtml(url, index, { alt: opts?.alts?.[index] ?? '' })
    )
    .join('');
  return {
    imagesHtml,
    containerDataAttr: lightboxContainerDataUrlsAttr(urls),
  };
}
