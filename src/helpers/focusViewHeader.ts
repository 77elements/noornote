/**
 * Focus view header (v2) — the shared heading pattern for domain surfaces.
 *
 * The h1 IS the header row: no wrapper div. Title on the left, an optional
 * `.btn` action inside the h1 on the right (social: "Write Note" →
 * composer, media: "Post Media" → video composer). Classic v1 renders the
 * same rows (TimelineView, ArticleTimelineView) with the h1 visually
 * hidden (titleClass contract) — the action button is display:none there
 * anyway, composition comes from the +New Post dropup.
 */

export interface FocusViewHeaderOptions {
  /** The h1 title. */
  title: string;
  /** Extra class on the h1 (view-scoped v1/v2 styling, e.g. sr-only in classic). */
  titleClass?: string;
  /** Action button label (rendered inside the h1, right-aligned). Omit → title only. */
  actionLabel?: string;
  /** Action click handler (wired to the focus navigation seam by the caller). */
  onAction?: (event: MouseEvent) => void;
}

export function createFocusViewHeader(
  options: FocusViewHeaderOptions
): HTMLElement {
  const h1 = document.createElement('h1');
  h1.className = options.titleClass
    ? `focus-view-header ${options.titleClass}`
    : 'focus-view-header';
  h1.textContent = options.title;

  if (options.actionLabel) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn focus-view-header__action';
    action.textContent = options.actionLabel;
    action.addEventListener('click', e => options.onAction?.(e));
    h1.appendChild(action);
  }

  return h1;
}
