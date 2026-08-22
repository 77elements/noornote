/**
 * In a composer Preview tab, a click on the rendered text jumps back to the
 * Edit tab — the same "click to resume editing" affordance as the Drafts list.
 * Clicks on interactive elements (links, mentions, media, quoted notes) are
 * left alone so they keep their own behaviour.
 */
export function attachPreviewClickToEdit(
  container: HTMLElement,
  onEdit: () => void
): void {
  container.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        'a, button, video, audio, img, .quote-preview, .mention-link, .note-media'
      )
    ) {
      return;
    }
    onEdit();
  });
}
