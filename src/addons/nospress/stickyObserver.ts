/**
 * Sticky-stuck state observer for NosPress public pages.
 *
 * CSS has no `:stuck` pseudo-class — but users want stuck-state styling
 * (drop-shadow, background tint, color shift, font-size shrink, …) when
 * a `position: sticky` header/footer transitions from "in flow" to
 * "pinned to viewport edge". The standard pattern is to insert a 1px
 * sentinel sibling at the element's natural anchor position and let an
 * IntersectionObserver flip a `.is-stuck` class on the sticky element
 * when the sentinel leaves the viewport.
 *
 * The CSS rules emitted by `buildBlockStickyCss` ride on the
 * `.is-stuck` class plus `!important`, so the transition declarations
 * on the base block (`transition-duration` / `transition-delay` /
 * `transition-timing-function`) drive the animation between states.
 *
 * Top-sticky (header, `top: <v>`): sentinel goes BEFORE the element so
 *   it scrolls out of the viewport top before the element pins.
 * Bottom-sticky (footer, `bottom: <v>`): sentinel goes AFTER the
 *   element so it scrolls out of the viewport bottom before the
 *   element pins.
 *
 * Mount runs ONLY on the public page (not in the editor — the editor
 * is strictly schematic per Sek 3.4 of `docs/todos/nospress.md`).
 */

const STICKY_DATA_ATTR = 'data-sticky-sentinel-for';
const SENTINEL_CLASS = 'nospress-sticky-sentinel';

interface StickyEntry {
  element: HTMLElement;
  sentinel: HTMLElement;
  observer: IntersectionObserver;
}

let entries: StickyEntry[] = [];

/**
 * Find every element with `position: sticky` inside `root`, attach a
 * sentinel + IntersectionObserver, return a disposer.
 *
 * Idempotent: previous mounts are torn down before scanning.
 */
export function mountStickyObservers(root: ParentNode): void {
  unmountStickyObservers();

  if (typeof IntersectionObserver === 'undefined') {
    // Server-side or very old browsers — silently no-op. The base
    // styles still apply; users just won't get the stuck-state shift.
    return;
  }

  // Scope on `[data-styled-block-id]` because that's the wrapper the
  // user actually styles. Plain CSS class wrappers (`.user-site__site-
  // header` etc.) carry no per-block sticky setting, so scanning those
  // would just be noise.
  const candidates = root.querySelectorAll<HTMLElement>('[data-styled-block-id]');
  for (const el of candidates) {
    const cs = window.getComputedStyle(el);
    if (cs.position !== 'sticky') continue;

    // Decide sentinel placement from the resolved top/bottom values.
    // `auto` means "not set"; `0px` / `10px` / etc. mean the user (or
    // SCSS default) wired a sticky offset on that side.
    const hasTop = cs.top && cs.top !== 'auto';
    const hasBottom = cs.bottom && cs.bottom !== 'auto';

    const sentinel = document.createElement('div');
    sentinel.className = SENTINEL_CLASS;
    sentinel.setAttribute(STICKY_DATA_ATTR, el.dataset.styledBlockId ?? '');
    sentinel.style.cssText = 'height:1px;width:100%;pointer-events:none;visibility:hidden;';

    if (hasTop && !hasBottom) {
      el.parentNode?.insertBefore(sentinel, el);
    } else if (hasBottom && !hasTop) {
      el.parentNode?.insertBefore(sentinel, el.nextSibling);
    } else if (hasTop && hasBottom) {
      // Both sides set → unusual, but top wins (header-style behaviour).
      el.parentNode?.insertBefore(sentinel, el);
    } else {
      // No offset set → browser treats `position: sticky` as no-op
      // (element behaves as relative). Don't attach an observer.
      continue;
    }

    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          // Sentinel out of view = element is stuck. Sentinel in view =
          // element is in normal flow.
          el.classList.toggle('is-stuck', !record.isIntersecting);
        }
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);

    entries.push({ element: el, sentinel, observer });
  }
}

/**
 * Tear down every observer + remove every sentinel. Called before a
 * re-mount and before SPA navigation away from the public page.
 */
export function unmountStickyObservers(): void {
  for (const entry of entries) {
    entry.observer.disconnect();
    entry.sentinel.remove();
    entry.element.classList.remove('is-stuck');
  }
  entries = [];
}
