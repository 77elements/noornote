/**
 * Tabs — central UI component for every `.tabs` row (v1 + v2).
 *
 * The horizontal scrollbar of `.tabs--scrollable` is gone: when the tab
 * buttons don't fit their container, the row collapses into an NnDropdown
 * (the app's standard select design); when room returns, the button row
 * comes back. Selection works both ways — picking an option clicks the
 * underlying tab (all existing caller wiring keeps working), and external
 * active-class changes sync back into the dropdown label.
 *
 * JS lives here, all styling in styles/molecules/_tabs.scss — one central
 * component, same pattern as Tooltip / NnDropdown / Switch.
 *
 * Self-wiring: `Tabs.install()` (called once at boot) picks up every
 * `.tabs` element already in the DOM and everything mounted after it
 * (views, addons, lists, focus surfaces) — no call-site changes anywhere.
 * Per container a ResizeObserver drives the fit check; a detached
 * container disconnects itself.
 */

import { NnDropdown } from './NnDropdown';

const OVERFLOW_TOLERANCE_PX = 1;
const COLLAPSED_CLASS = 'tabs--collapsed';
const DROPDOWN_CLASS = 'tabs__dropdown';

export class Tabs {
  /** The document-level installer (mount watcher). */
  private static watcher: MutationObserver | null = null;
  /** Containers already wired (weak: removal lets them be collected). */
  private static wired = new WeakSet<HTMLElement>();

  /**
   * Start the global watcher. Idempotent — call once at boot; it covers
   * every .tabs element already in the DOM and everything mounted after.
   */
  static install(): void {
    if (Tabs.watcher) return;
    document.querySelectorAll<HTMLElement>('.tabs').forEach(el => {
      Tabs.attach(el);
    });
    Tabs.watcher = new MutationObserver(mutations => {
      for (const m of mutations) {
        m.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          if (node.classList.contains('tabs')) Tabs.attach(node);
          node
            .querySelectorAll<HTMLElement>('.tabs')
            .forEach(el => Tabs.attach(el));
        });
      }
    });
    Tabs.watcher.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Wire one `.tabs` container. Returns the disposer (used internally on
   * detachment; tests may use it too).
   */
  static attach(container: HTMLElement): () => void {
    if (Tabs.wired.has(container)) return () => {};
    Tabs.wired.add(container);
    // Environments without ResizeObserver (tests): no wiring, the row
    // keeps its plain scroll behavior there.
    if (typeof ResizeObserver === 'undefined') return () => {};

    let dropdown: NnDropdown | null = null;
    let host: HTMLElement | null = null;
    let scheduled = false;
    let measurer: HTMLElement | null = null;

    const tabs = (): HTMLElement[] => [
      ...container.querySelectorAll<HTMLElement>(':scope > .tab'),
    ];

    /** One check per frame — the DOM writes here re-trigger the observers. */
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        check();
      });
    };

    const buildDropdown = (): void => {
      const list = tabs();
      if (!list.length) return;
      const activeIndex = list.findIndex(t =>
        t.classList.contains('tab--active')
      );
      container.classList.add(COLLAPSED_CLASS);
      host = document.createElement('div');
      host.className = DROPDOWN_CLASS;
      container.appendChild(host);
      dropdown = new NnDropdown({
        options: list.map((t, i) => ({
          value: String(i),
          label: (t.textContent || '').trim(),
        })),
        selectedValue: String(Math.max(0, activeIndex)),
        width: '100%',
        className: DROPDOWN_CLASS,
        // Selecting an option clicks the real tab — the caller's own
        // listener does the switching, Tabs only mirrors the result.
        onChange: value => tabs()[Number(value)]?.click(),
      });
      host.appendChild(dropdown.getElement());
    };

    const teardownDropdown = (): void => {
      dropdown?.destroy();
      dropdown = null;
      host?.remove();
      host = null;
      container.classList.remove(COLLAPSED_CLASS);
    };

    const syncActive = (): void => {
      if (!dropdown) return;
      const idx = tabs().findIndex(t => t.classList.contains('tab--active'));
      if (idx < 0) return;
      // Only write on an actual change: setValue rewrites the label/items,
      // and an unconditional write here would feed the MutationObserver
      // below its own tail (rAF loop, visual jitter).
      if (dropdown.getValue() !== String(idx)) dropdown.setValue(String(idx));
    };

    /**
     * Natural width of the plain button row, measured off-flow. While the
     * row is collapsed the live scrollWidth always equals clientWidth
     * (the dropdown fills the container), so the plain fit check would
     * tear the dropdown down, re-show the tabs, overflow, rebuild — an
     * oscillation that shakes the whole view. Cloning the tabs into a
     * hidden measurer (outside the observed container → no observer
     * feedback) answers "would the buttons fit again?" without touching
     * the live row.
     */
    const naturalRowWidth = (): number => {
      const list = tabs();
      if (!list.length) return 0;
      if (!measurer) {
        measurer = document.createElement('div');
        measurer.className = 'tabs tabs--measure';
      }
      measurer.replaceChildren(...list.map(t => t.cloneNode(true)));
      document.body.appendChild(measurer);
      const width = measurer.offsetWidth;
      measurer.remove();
      return width;
    };

    const check = (): void => {
      if (!container.isConnected) {
        // Self-cleanup: the row left the DOM (view re-render, teardown).
        ro.disconnect();
        mo.disconnect();
        Tabs.wired.delete(container);
        measurer?.remove();
        measurer = null;
        teardownDropdown();
        return;
      }
      // Not yet laid out (hidden view at mount time): wait for a box.
      if (container.clientWidth === 0 && container.scrollWidth === 0) return;
      if (!dropdown) {
        const overflows =
          container.scrollWidth > container.clientWidth + OVERFLOW_TOLERANCE_PX;
        if (overflows) buildDropdown();
      } else if (
        naturalRowWidth() <=
        container.clientWidth + OVERFLOW_TOLERANCE_PX
      ) {
        // Room came back — restore the plain button row.
        teardownDropdown();
      } else {
        syncActive();
      }
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    // Active tab switches are class changes; rebuilds add/remove tabs.
    const mo = new MutationObserver(schedule);
    mo.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    check();

    return () => {
      ro.disconnect();
      mo.disconnect();
      Tabs.wired.delete(container);
      measurer?.remove();
      measurer = null;
      teardownDropdown();
    };
  }
}
