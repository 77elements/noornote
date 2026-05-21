/**
 * Click-trigger runtime for flip-card blocks on the public page.
 *
 * Hover-trigger blocks need no JS — the SCSS uses `:hover`. Click-trigger
 * blocks toggle `.is-flipped` on the wrapper, which the SCSS reads with
 * `[data-flip-trigger="click"].is-flipped`.
 *
 * The runtime is purely additive: it skips blocks with `flip-trigger="hover"`
 * (the default) and only attaches handlers to click-mode instances.
 *
 * Defensive against repeat-mount calls (e.g. when the bootstrap runs more
 * than once during navigation): each card is tagged with a data flag so
 * we don't stack listeners. Unmount tears everything down via AbortController.
 */

let abortController: AbortController | null = null;

const MOUNTED_FLAG = 'flipCardClickMounted';

export function mountFlipCardRuntime(root: HTMLElement): void {
  // One controller per mount cycle — `unmount` aborts all listeners + the
  // re-entrancy guards reset on the next mount call.
  abortController = new AbortController();
  const { signal } = abortController;

  const cards = root.querySelectorAll<HTMLElement>('.nospress-block-flip-card[data-flip-trigger="click"]');
  cards.forEach(card => {
    if (card.dataset[MOUNTED_FLAG]) return;
    card.dataset[MOUNTED_FLAG] = '1';

    const toggle = (e: Event) => {
      // Let real links / buttons inside the face do their thing on the
      // VISIBLE face. The first click swaps faces; second click on the
      // now-visible face's link fires normally because it's not blocked.
      const target = e.target as HTMLElement | null;
      if (target && target.closest('a, button, input, textarea, select')) return;
      card.classList.toggle('is-flipped');
    };

    card.addEventListener('click', toggle, { signal });

    // Keyboard parity: Enter / Space flip the card when it's focused via
    // tab (the renderer sets tabindex="0" + role="button" for click-mode
    // cards). Skip arrow keys / others so scroll behaviour is unaffected.
    card.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if (key !== 'Enter' && key !== ' ') return;
      e.preventDefault();
      toggle(e);
    }, { signal });
  });
}

export function unmountFlipCardRuntime(): void {
  abortController?.abort();
  abortController = null;
  // Clear the mounted flag so a fresh mount call re-attaches handlers
  // (the cards themselves stay in the DOM across navigation).
  document.querySelectorAll<HTMLElement>(`.nospress-block-flip-card[data-${MOUNTED_FLAG.toLowerCase()}]`)
    .forEach(c => { delete c.dataset[MOUNTED_FLAG]; });
}
