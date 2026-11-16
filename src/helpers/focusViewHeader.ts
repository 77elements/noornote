/**
 * Focus view header (v2) — the shared heading pattern for domain surfaces.
 *
 * A `.l-row--split.focus-view-header` wrapper row: the h1 title on the
 * left, an optional `.btn` action on the right (social: "Write Note" →
 * composer, media: "Post Media" → video composer). The button is a
 * SIBLING of the h1 — inside the h1 it would inherit the heading's
 * 27px. Classic v1 renders the same rows (TimelineView,
 * ArticleTimelineView) with the h1 visually hidden (titleClass contract)
 * — the action button is display:none there anyway, composition comes
 * from the +New Post dropup.
 */

export interface FocusViewHeaderOptions {
  /** The h1 title. */
  title: string;
  /** Extra class on the h1 (view-scoped v1/v2 styling, e.g. sr-only in classic). */
  titleClass?: string;
  /** Action button label (rendered right of the h1). Omit → title only. */
  actionLabel?: string;
  /** Action click handler (wired to the focus navigation seam by the caller). */
  onAction?: (event: MouseEvent) => void;
}

export function createFocusViewHeader(
  options: FocusViewHeaderOptions
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'l-row--split focus-view-header';

  const h1 = document.createElement('h1');
  h1.className = options.titleClass ?? '';
  h1.textContent = options.title;
  row.appendChild(h1);

  if (options.actionLabel) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn focus-view-header__action';
    action.textContent = options.actionLabel;
    action.addEventListener('click', e => options.onAction?.(e));
    row.appendChild(action);
  }

  return row;
}
