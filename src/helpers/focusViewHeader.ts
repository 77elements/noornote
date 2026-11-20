/**
 * Focus view header — the shared heading pattern for domain surfaces.
 *
 * The bare h1 title, hooked via .fv.fv--<object> (_focus-shell.scss).
 * Write actions do NOT live here: the v2 Focus UI carries exactly one write
 * entry per domain — the side stack's primary action row (FocusDomainDef
 * .primaryAction); classic v1 composes from the +New Post dropup.
 */

export interface FocusViewHeaderOptions {
  /** The h1 title. */
  title: string;
  /** The focus object name — styles the h1 via .fv.fv--<object> (_focus-shell.scss). */
  object?: string;
}

export function createFocusViewHeader(
  options: FocusViewHeaderOptions
): HTMLElement {
  const h1 = document.createElement('h1');
  h1.className = options.object ? `fv fv--${options.object}` : 'fv';
  h1.textContent = options.title;
  return h1;
}
