/**
 * Shared View Transitions wrapper.
 *
 * Runs a DOM update inside `document.startViewTransition()` when the browser
 * supports it and the user has no reduced-motion preference — everywhere else
 * (old Chromium, Firefox <139, reduced motion) it falls back to the plain
 * instant cut.
 */

export function withViewTransition(apply: () => void): void {
  const reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;
  const doc = document as Document & {
    startViewTransition?: (updateCallback: () => void) => unknown;
  };
  if (reducedMotion || typeof doc.startViewTransition !== 'function') {
    apply();
    return;
  }
  doc.startViewTransition(apply);
}
