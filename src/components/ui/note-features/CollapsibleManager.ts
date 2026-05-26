/**
 * CollapsibleManager
 *
 * Generic "clamp a container to a max height, show a Show More / Show Less
 * button when content exceeds it" helper. Agnostic of what's inside — used
 * by timeline note-cards and by quote-boxes embedded in article bodies.
 *
 * Measurement-based: once the target scrolls into view, we measure the real
 * rendered height and decide whether to collapse. A ResizeObserver re-runs
 * the check as late-loading content (images, videos) changes the height.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../../services/PerAccountLocalStorage';
import { TypedEventBus } from '../../../core/TypedEventBus';

export interface CollapsibleOptions {
  /** Max height when collapsed, e.g. '40vh'. Applied via CSS var. */
  maxHeight: string;
  /** Selector for the inner content root whose children get wrapped. If
   *  omitted, the container itself is used. Example: '.event-content' for
   *  quote-boxes so the header stays outside the collapsible area. */
  contentSelector?: string;
  /** Direct children of the content root matching this selector stay OUTSIDE
   *  the collapsible wrapper (e.g. interaction bars). Default: '.isl'. */
  excludeSelector?: string;
}

interface MeasurementTarget {
  wrapper: HTMLElement;
  btn: HTMLElement;
}

// Shared IntersectionObserver — runs an initial measurement exactly once per
// target as it enters the viewport. After that, a per-target ResizeObserver
// keeps the collapsed state in sync with late size changes.
let sharedObserver: IntersectionObserver | null = null;
const pendingMeasurements: Map<Element, MeasurementTarget> = new Map();

function getSharedObserver(): IntersectionObserver {
  if (sharedObserver) return sharedObserver;

  sharedObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const data = pendingMeasurements.get(entry.target);
      if (!data) return;

      sharedObserver!.unobserve(entry.target);
      pendingMeasurements.delete(entry.target);
      setTimeout(() => {
        requestAnimationFrame(() => {
          CollapsibleManager.checkAndCollapse(data.wrapper, data.btn);
        });
      }, 100);
    });
  }, { threshold: 0.01, rootMargin: '50px' });

  return sharedObserver;
}

export class CollapsibleManager {
  /** Only collapse if content exceeds maxHeight by at least this many vh. */
  private static readonly MIN_OVERFLOW_VH = 0.05; // 5vh
  private static initialized = false;

  /**
   * Initialize global event listeners (call once on app start).
   */
  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    TypedEventBus.getInstance().on('settings:post-truncation-changed', () => {
      document.querySelectorAll<HTMLElement>('.collapsible-wrapper').forEach(wrapper => {
        const btn = wrapper.parentElement?.querySelector<HTMLElement>(':scope > .btn--show-more');
        if (btn) CollapsibleManager.checkAndCollapse(wrapper, btn);
      });
    });
  }

  /**
   * Wrap `container` (or an inner element selected by `options.contentSelector`)
   * in a collapsible-wrapper and append a Show More button. The actual clamp
   * applies once the element scrolls into view and its rendered height is
   * known to exceed `options.maxHeight`.
   */
  static setup(container: HTMLElement, options: CollapsibleOptions): void {
    const { maxHeight, contentSelector, excludeSelector = '.isl' } = options;

    const contentRoot = contentSelector
      ? container.querySelector<HTMLElement>(contentSelector)
      : container;
    if (!contentRoot) return;

    const excludedChild = excludeSelector
      ? contentRoot.querySelector<HTMLElement>(`:scope > ${excludeSelector}`)
      : null;

    const wrapper = document.createElement('div');
    wrapper.className = 'collapsible-wrapper';
    wrapper.style.setProperty('--collapsible-max-height', maxHeight);

    // Use childNodes (not children) so text nodes — which carry the actual
    // paragraph text between <br>/<img>/<div> elements — move into the
    // wrapper too. With children (Element-only) the text would stay
    // orphaned in contentRoot, leaving adjacent <br>s visually stacked.
    Array.from(contentRoot.childNodes)
      .filter(child => child !== excludedChild)
      .forEach(child => wrapper.appendChild(child));

    if (excludedChild) {
      contentRoot.insertBefore(wrapper, excludedChild);
    } else {
      contentRoot.appendChild(wrapper);
    }

    const showMoreBtn = document.createElement('button');
    showMoreBtn.className = 'btn btn--passive btn--show-more';
    showMoreBtn.setAttribute('data-action', 'show-more');
    showMoreBtn.textContent = 'Show More';
    showMoreBtn.style.display = 'none';

    if (excludedChild) {
      contentRoot.insertBefore(showMoreBtn, excludedChild);
    } else {
      contentRoot.appendChild(showMoreBtn);
    }

    showMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = wrapper.classList.toggle('is-collapsed');
      wrapper.classList.toggle('is-expanded', !collapsed);
      showMoreBtn.textContent = collapsed ? 'Show More' : 'Show Less';
    });

    pendingMeasurements.set(contentRoot, { wrapper, btn: showMoreBtn });
    getSharedObserver().observe(contentRoot);

    // Re-check whenever the wrapper's height changes (images loading, media
    // placeholders resolving, fonts settling): the initial measurement runs
    // before paints complete, so without this a quote with images would keep
    // its pre-load height and never trigger Show More.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        CollapsibleManager.checkAndCollapse(wrapper, showMoreBtn);
      });
      ro.observe(wrapper);
    }
  }

  /**
   * Measure the wrapper and flip collapsed/expanded state if the content
   * exceeds its max height by more than MIN_OVERFLOW_VH. Public because
   * settings changes (post-truncation toggle) re-run it across all wrappers.
   */
  static checkAndCollapse(wrapperEl: HTMLElement, btnEl: HTMLElement): void {
    const storage = PerAccountLocalStorage.getInstance();
    if (storage.get<boolean>(StorageKeys.DISABLE_POST_TRUNCATION, false)) {
      btnEl.style.display = 'none';
      wrapperEl.classList.remove('is-collapsed', 'is-expanded');
      return;
    }

    if (wrapperEl.classList.contains('is-expanded')) return; // Respect user toggle.

    const thresholdPx = parseCssLength(
      wrapperEl.style.getPropertyValue('--collapsible-max-height').trim()
    );
    if (thresholdPx === null) return;

    const minOverflowPx = window.innerHeight * CollapsibleManager.MIN_OVERFLOW_VH;
    const overflowing = wrapperEl.scrollHeight > thresholdPx + minOverflowPx;

    if (overflowing) {
      btnEl.style.display = 'block';
      wrapperEl.classList.add('is-collapsed');
      btnEl.textContent = 'Show More';
    } else {
      btnEl.style.display = 'none';
      wrapperEl.classList.remove('is-collapsed');
    }
  }
}

/** Parse a CSS length (vh, px, rem, em) to pixels. Returns null on failure. */
function parseCssLength(value: string): number | null {
  const match = /^(-?\d*\.?\d+)(vh|px|rem|em)$/.exec(value);
  if (!match) return null;
  const num = parseFloat(match[1]!);
  const rootFontSize = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
  switch (match[2]) {
    case 'vh': return window.innerHeight * num / 100;
    case 'px': return num;
    case 'rem': return num * rootFontSize();
    case 'em': return num * rootFontSize();
    default: return null;
  }
}
