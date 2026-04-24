/**
 * upgradeArticleImages
 *
 * Promotes plain <img> tags inside a long-form article body (kind 30023) to
 * the same lightbox-clickable contract that timeline notes use:
 *
 *   <img class="note-image note-image--clickable" data-image-index="N">
 *   wrapped in: <div class="note-media" data-image-urls="<encoded gallery>">
 *
 * The global ImageClickHandler (delegated listener on document.body) then
 * fires for these images automatically — no per-element click handler, no
 * risk of pre-empting the inviolable media-click rule.
 *
 * All eligible images in the same article share one gallery, so the lightbox
 * lets the reader swipe between them as a sequence.
 *
 * Skipped:
 *   - images already wrapped in .note-media (e.g. inside an embedded quote
 *     box — they are handled by their own renderer)
 *   - images inside an <a> link (the link should win on click)
 *   - images inside a user-mention (profile pictures inline in mentions)
 *   - images without a src
 */
export function upgradeArticleImages(container: HTMLElement): void {
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
  const candidates = imgs.filter(img =>
    img.getAttribute('src') &&
    !img.classList.contains('note-image--clickable') &&
    !img.closest('.note-media') &&
    !img.closest('a') &&
    !img.closest('.user-mention')
  );
  if (candidates.length === 0) return;

  const urls = candidates.map(img => img.src);
  const dataImageUrls = encodeURIComponent(JSON.stringify(urls));

  candidates.forEach((img, index) => {
    img.classList.add('note-image', 'note-image--clickable');
    img.setAttribute('data-image-index', String(index));

    const wrapper = document.createElement('div');
    wrapper.className = 'note-media';
    wrapper.setAttribute('data-image-urls', dataImageUrls);
    img.replaceWith(wrapper);
    wrapper.appendChild(img);
  });
}
