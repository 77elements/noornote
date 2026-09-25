/**
 * Shared View Transitions wrapper.
 *
 * Runs a DOM update inside `document.startViewTransition()` when the browser
 * supports it and the user has no reduced-motion preference — everywhere else
 * (old Chromium, Firefox <139, reduced motion) it falls back to the plain
 * instant cut. `direction` adds the html.router-nav-forward/back classes that
 * drive the directional keyframes for the pcc layer (CSS in _main-layout.scss);
 * call without `direction` for a plain cross-fade (scc tab switches).
 */

export interface ViewTransitionOptions {
  /** Adds the html classes that key the directional pcc keyframes. */
  direction?: 'forward' | 'back';
}

export function withViewTransition(
  apply: () => void,
  opts: ViewTransitionOptions = {}
): void {
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
  if (opts.direction) {
    const back = opts.direction === 'back';
    const root = document.documentElement;
    root.classList.toggle('router-nav-back', back);
    root.classList.toggle('router-nav-forward', !back);
  }
  doc.startViewTransition(apply);
}
