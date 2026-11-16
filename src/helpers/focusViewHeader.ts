/**
 * Focus view header (v2) — the shared heading pattern for domain surfaces.
 *
 * Same DOM contract as the social timeline's title row: a
 * `.focus-view-header.l-row--split` container with the h1 on the left and
 * an optional `.btn` action on the right (social: "Write Note" →
 * composer, media: "Post Media" → video composer). Classic v1 renders
 * the same rows (TimelineView, ArticleTimelineView) with the action
 * button CSS-hidden — composition comes from the +New Post dropup there.
 */

export interface FocusViewHeaderOptions {
  /** The h1 title. */
  title: string;
  /** Extra class on the h1 (view-scoped v1/v2 styling, e.g. sr-only in classic). */
  titleClass?: string;
  /** Right-side action button label. Omit → heading only. */
  actionLabel?: string;
  /** Action click handler (wired to the focus navigation seam by the caller). */
  onAction?: (event: MouseEvent) => void;
}

export function createFocusViewHeader(
  options: FocusViewHeaderOptions
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'focus-view-header l-row--split';

  const h1 = document.createElement('h1');
  h1.textContent = options.title;
  if (options.titleClass) h1.className = options.titleClass;
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
