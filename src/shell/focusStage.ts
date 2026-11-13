/**
 * Focus Stage (v2) — builds the FS grid of primary domain circles inside
 * #focus-stage and owns the unified morph logic: clicking a circle grows
 * it into the center column (600px), the other circles shift aside, the
 * domain surface mounts BEFORE the morph — document flow: the column
 * height is its content height, so the FLIP animates to the laid-out
 * final geometry. The close control reverses the morph and restores the
 * grid.
 *
 * Morph technique: FLIP on the real elements via the Web Animations API.
 * The grid switches to `1fr 600px 1fr` and every object animates from its
 * previous geometry to the new one — top-left-anchored translate for the
 * position delta, px-animated width/height for size changes (no scale, so
 * the 2px border stays 2px; animated height is capped at the viewport
 * bottom — the beyond-fold rest snaps invisibly after the animation), and
 * border-radius 50% → column radius only on the active object.
 * `prefers-reduced-motion` skips the animation.
 *
 * Under the morph breakpoint (1100px) there is no FLIP: a simple full-
 * width column takeover (mobile behavior).
 *
 * Only one domain can be focused at a time (PoC). Surfaces are cached per
 * domain: closing pauses the view, reopening re-mounts and resumes it.
 */

import { _ } from '../i18n';
import { Router } from '../services/Router';
import {
  FOCUS_DOMAINS,
  type FocusDomainDef,
  type FocusDomainSurface,
} from './focusDomains';

/** URL of the home grid (no domain focused). */
const HOME_ROUTE = '/';

/** Morph duration/easing — single source for open and close. */
const MORPH_MS = 380;
const MORPH_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** Below this viewport width: column takeover instead of FLIP morph. */
const MORPH_MIN_WIDTH = 1100;
/** Media query mirroring the SCSS takeover breakpoint (must stay in sync). */
const MORPH_MIN_QUERY = `(max-width: ${MORPH_MIN_WIDTH - 1}px)`;
/** Column scrolled this far → the scroll-to-top action appears (v1 parity). */
const SCROLL_TOP_THRESHOLD = 100;

export class FocusStage {
  private root: HTMLElement;
  private grid!: HTMLElement;
  private objects = new Map<string, HTMLElement>();
  private surfaces = new Map<string, FocusDomainSurface>();
  /** Side stacks while a domain is focused (see reparentSideStacks). */
  private sideStacks: [HTMLElement, HTMLElement] | null = null;
  private activeId: string | null = null;
  private morphing = false;
  /** Per-object scroll-to-top action state (button + last scroll source). */
  private scrollTopState = new Map<
    string,
    { btn: HTMLElement; source: HTMLElement | null }
  >();
  private lastWidth = window.innerWidth;
  private onResize = (): void => {
    const width = window.innerWidth;
    if (width === this.lastWidth) return;
    this.lastWidth = width;
    // Height-only resizes (devtools docked bottom, window grow) must keep
    // the focused column — only WIDTH changes matter for the layout mode.
    if (!this.activeId || this.morphing) return;
    const def = FOCUS_DOMAINS.find(d => d.id === this.activeId);
    const el = def ? this.objects.get(def.id) : undefined;
    if (!def || !el) return;
    const takeOver = window.matchMedia(MORPH_MIN_QUERY).matches;
    if (takeOver) {
      // Crossed DOWN into takeover: drop the FLIP artifacts (inline
      // placement, side stacks) — the takeover CSS holds the column alone.
      el.style.gridColumn = '';
      this.restoreSideCircles();
    } else if (!this.sideStacks) {
      // Crossed UP into FLIP mode: re-place the column and re-parent the
      // side stacks (takeover left the circles flat in the grid).
      el.style.gridColumn = '2';
      this.reparentSideStacks(def.id);
    }
    // Same-mode width changes: pure CSS reflow, nothing to do.
  };

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** Build the FS grid into the stage element. */
  mount(): void {
    this.grid = document.createElement('div');
    this.grid.className = 'focus-stage__grid';
    for (const def of FOCUS_DOMAINS) {
      this.grid.appendChild(this.createObject(def));
    }
    this.root.appendChild(this.grid);
    window.addEventListener('resize', this.onResize);
  }

  /** Full teardown (shell unmount): destroy every cached surface. */
  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    for (const surface of this.surfaces.values()) {
      surface.view?.destroy?.();
    }
    this.surfaces.clear();
    this.objects.clear();
    this.scrollTopState.clear();
    this.grid?.remove();
  }

  /**
   * Re-open a domain's surface from its route (boot/reload restore): the
   * URL is already correct, the surface opens with the standard morph.
   */
  restoreDomain(def: FocusDomainDef): void {
    const el = this.objects.get(def.id);
    if (el) void this.open(def, el);
  }

  /**
   * Focus navigation seam: hand a view type to the ACTIVE surface's
   * column (e.g. a note click in the timeline). Returns false when no
   * surface is focused or it does not own the view type — the caller
   * (ViewNavigationController) then navigates the classic way.
   */
  handleFocusNav(viewType: string, param?: string): boolean {
    if (!this.activeId) return false;
    const surface = this.surfaces.get(this.activeId);
    return surface?.view?.handleFocusNav?.(viewType, param) ?? false;
  }

  private createObject(def: FocusDomainDef): HTMLElement {
    const el = document.createElement('div');
    el.className = 'focus-object';
    el.dataset.domainId = def.id;
    el.innerHTML = `
      <button type="button" class="focus-object__hit">
        ${def.icon ? `<svg class="focus-object__icon"><use href="#${def.icon}"/></svg>` : ''}
        <span class="focus-object__label">${def.label}</span>
      </button>
      <div class="focus-object__actions">
        <button type="button" class="focus-object__control"
          aria-label="${_('Close')}">
          <svg width="15" height="15" aria-hidden="true"><use href="#icon-close"/></svg>
        </button>
        <button type="button" class="focus-object__back" hidden
          aria-label="${_('Back')}">
          <svg width="15" height="15" aria-hidden="true"><use href="#icon-back"/></svg>
        </button>
        <button type="button" class="focus-object__scroll-top" hidden
          aria-label="${_('Scroll to top')}">
          <svg width="15" height="15" aria-hidden="true" class="focus-object__scroll-top-icon"><use href="#icon-back"/></svg>
        </button>
      </div>
      <div class="focus-object__surface"></div>
    `;
    el.addEventListener('click', () => void this.onObjectClick(def, el));
    const control = el.querySelector('.focus-object__control') as HTMLElement;
    control.addEventListener('click', e => {
      // The control only exists on the active object (hidden in grid state
      // via CSS) and always means "close"; never re-trigger "open".
      e.stopPropagation();
      if (this.activeId === def.id && !this.morphing) {
        e.stopPropagation();
        this.close();
      }
    });
    // Action-button stack: the surface reports detail state via the frame
    // (focusSurfaceFrame.setBackVisible bubbles 'focus:surface-back') —
    // the back action shows only while a detail replaces the list.
    const backBtn = el.querySelector('.focus-object__back') as HTMLElement;
    el.addEventListener('focus:surface-back', e => {
      const detail = (e as CustomEvent<{ visible?: boolean }>).detail;
      backBtn.hidden = !detail?.visible;
      // Sync the scroll-to-top action with the swap (no scroll event
      // fires when a view replaces another): a fresh detail starts at
      // the top — hide; back on the list means its preserved scroll
      // position — resync (button reappears if the list stayed scrolled).
      const st = this.scrollTopState.get(def.id);
      if (st) {
        if (detail?.visible) {
          st.btn.hidden = true;
        } else {
          const slot = el.querySelector(
            '.focus-object__surface'
          ) as HTMLElement;
          st.source = this.findMainScroller(slot);
          st.btn.hidden = !(
            st.source && st.source.scrollTop > SCROLL_TOP_THRESHOLD
          );
        }
      }
    });
    backBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (this.activeId !== def.id || this.morphing) return;
      this.surfaces.get(def.id)?.view?.back?.();
    });

    // Scroll-to-top action: visible once the column's main scroller is
    // scrolled past the threshold, scrolls it back smooth on click. The
    // captured scroll listener reaches BOTH scroll models — the slot
    // itself (articles: the column scrolls) and internal scrollers
    // (social: the timeline scrolls inside the view) — scroll doesn't
    // bubble, but capture on the slot receives every descendant's event.
    const slot = el.querySelector('.focus-object__surface') as HTMLElement;
    const scrollTopBtn = el.querySelector(
      '.focus-object__scroll-top'
    ) as HTMLElement;
    const scrollTop = { btn: scrollTopBtn, source: null as HTMLElement | null };
    this.scrollTopState.set(def.id, scrollTop);
    slot.addEventListener(
      'scroll',
      e => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        // Ignore stale events from views swapped out of the column (a
        // detached timeline keeps polling and scrolling) — only elements
        // currently IN the column drive the action.
        if (!slot.contains(t)) return;
        // Only the column's main scroller drives the action — the slot
        // itself, or a descendant scroller occupying most of the column
        // (social timeline). Small nested scrollers (dropdowns) don't.
        if (t !== slot && t.clientHeight < slot.clientHeight * 0.6) return;
        scrollTop.source = t;
        scrollTop.btn.hidden = t.scrollTop <= SCROLL_TOP_THRESHOLD;
      },
      true
    );
    scrollTopBtn.addEventListener('click', e => {
      e.stopPropagation();
      const t = scrollTop.source ?? this.findMainScroller(slot);
      t?.scrollTo({ top: 0, behavior: 'smooth' });
    });
    this.objects.set(def.id, el);
    return el;
  }

  /**
   * The column's main scroll container: the slot itself when it overflows
   * (articles), otherwise the first descendant that actually scrolls and
   * occupies most of the column (the social timeline's inner scroller).
   * Only called on open and click — never per scroll event.
   */
  private findMainScroller(slot: HTMLElement): HTMLElement | null {
    const scrollable = (n: Element): boolean => {
      const s = window.getComputedStyle(n);
      return (
        (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
        (n as HTMLElement).scrollHeight > (n as HTMLElement).clientHeight
      );
    };
    if (scrollable(slot)) return slot;
    for (const d of slot.querySelectorAll('*')) {
      if (d instanceof HTMLElement && scrollable(d)) return d;
    }
    return null;
  }

  private async onObjectClick(
    def: FocusDomainDef,
    el: HTMLElement
  ): Promise<void> {
    if (this.morphing || this.activeId) return; // one focus at a time (PoC)
    if (!def.createSurface) return; // placeholder domain, no surface yet
    await this.open(def, el);
  }

  private async open(def: FocusDomainDef, el: HTMLElement): Promise<void> {
    this.morphing = true;
    this.activeId = def.id;
    // URL follows the focus: the focused domain's route replaces the home
    // '/' in place (no history entry — Back stays with the browser).
    if (def.route) Router.getInstance().replaceUrl(def.route);
    const takeOver = window.matchMedia(MORPH_MIN_QUERY).matches;

    // Surface mounts BEFORE the morph: in document flow the column height
    // is its content height — the FLIP needs the laid-out final geometry.
    // Mount + class flip + measurement happen in one task (no paint in
    // between), so the content never shows inside the small circle.
    const surface = await this.ensureSurface(def);
    if (this.activeId !== def.id) {
      this.morphing = false; // closed again while loading
      return;
    }
    const slot = el.querySelector('.focus-object__surface') as HTMLElement;
    slot.appendChild(surface.element);
    surface.view?.resume?.();
    // A reopened (cached) surface may already be scrolled — sync the
    // scroll-to-top action to the restored state.
    const st = this.scrollTopState.get(def.id);
    if (st) {
      st.source = this.findMainScroller(slot);
      st.btn.hidden = !(
        st.source && st.source.scrollTop > SCROLL_TOP_THRESHOLD
      );
    }

    let morphDone: Promise<unknown> = Promise.resolve();
    if (takeOver) {
      // Mobile takeover: no FLIP, CSS alone turns the object into the column.
      el.classList.add('focus-object--active');
      this.grid.classList.add('is-focused');
    } else {
      // FLIP: measure, switch the grid, then animate to the new geometry.
      // The side circles re-parent into per-side stacks so their rows
      // stay compact while the active column's content height stretches
      // the middle row (in flow → the page scrolls the column).
      const first = this.measureAll();
      this.grid.classList.add('is-focused');
      el.classList.add('focus-object--active');
      el.style.gridColumn = '2';
      this.reparentSideStacks(def.id);
      morphDone = this.flipAll(first);
    }

    await morphDone;
    if (this.activeId !== def.id) {
      this.morphing = false; // closed (e.g. resize) during the morph
      return;
    }
    this.morphing = false;
  }

  private close({ animate = true }: { animate?: boolean } = {}): void {
    if (!this.activeId) return;
    if (this.morphing && animate) return; // a morph is already running
    const def = FOCUS_DOMAINS.find(d => d.id === this.activeId);
    const el = def ? this.objects.get(def.id) : undefined;
    if (!def || !el) return;
    const takeOver = window.matchMedia(MORPH_MIN_QUERY).matches;

    // Capture the focused geometry FIRST (content still mounted): in
    // document flow the column height is its content — after the surface
    // detaches, the box collapses and the morph-back would start from a
    // sliver.
    const first = animate && !takeOver ? this.measureAll() : null;

    // Detach the surface first: the view pauses, its element is kept
    // cached so reopening does not refetch everything. The surface
    // returns to its list state — reopening never shows a stale detail.
    const surface = this.surfaces.get(def.id);
    if (surface) {
      surface.view?.pause?.();
      surface.view?.reset?.();
      surface.element.remove();
    }
    // The column is gone — reset the scroll-to-top action for a clean
    // reopen (hidden until the user scrolls again).
    const st = this.scrollTopState.get(def.id);
    if (st) {
      st.source = null;
      st.btn.hidden = true;
    }

    el.classList.remove('focus-object--active');
    this.grid.classList.remove('is-focused');
    el.style.gridColumn = '';
    this.activeId = null;
    // Back to the home grid URL (no-op when already there).
    Router.getInstance().replaceUrl(HOME_ROUTE);
    this.restoreSideCircles();
    if (!first) return; // takeover / no-animate: plain class flip

    // FLIP back: focused geometry → circle geometry.
    this.morphing = true;
    void this.flipAll(first).then(() => {
      this.morphing = false;
    });
  }

  /**
   * Re-parent the non-active circles into two per-side stacks (grid
   * columns 1 and 3). In one flat grid the active object's content height
   * would be distributed across all spanned rows (circles spread over
   * thousands of px); inside the stacks they keep their compact 230px
   * rhythm while the middle column stretches in document flow.
   */
  private reparentSideStacks(activeId: string): void {
    const left = document.createElement('div');
    left.className = 'focus-side-stack';
    left.style.gridColumn = '1';
    const right = document.createElement('div');
    right.className = 'focus-side-stack';
    right.style.gridColumn = '3';
    let next: HTMLElement = left;
    for (const def of FOCUS_DOMAINS) {
      if (def.id === activeId) continue;
      const circle = this.objects.get(def.id);
      if (!circle) continue;
      next.appendChild(circle);
      next = next === left ? right : left;
    }
    const active = this.objects.get(activeId) as HTMLElement;
    this.grid.insertBefore(left, active);
    this.grid.insertBefore(right, active.nextSibling);
    this.sideStacks = [left, right];
  }

  /** Move the circles back into the grid (registry order) and drop the stacks. */
  private restoreSideCircles(): void {
    if (!this.sideStacks) return;
    // Append EVERY circle in registry order — including the one that
    // stayed in the grid as the focused column. appendChild moves it, so
    // the original order (social → articles → …) is restored exactly;
    // re-appending only the stacked circles would place them all AFTER
    // the formerly active object and shuffle the grid.
    for (const def of FOCUS_DOMAINS) {
      const circle = this.objects.get(def.id);
      if (circle) this.grid.appendChild(circle);
    }
    for (const stack of this.sideStacks) stack.remove();
    this.sideStacks = null;
  }

  /**
   * Shared FLIP used by open and close: every object animates from its
   * `first` geometry to the current (post-layout) one. Border-radius only
   * animates on the active object (circle → column radius → circle).
   */
  private async flipAll(first: Map<HTMLElement, DOMRect>): Promise<void> {
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    const animations: Promise<unknown>[] = [];
    // In flow the active column can be far taller than the viewport —
    // animating the full height is wasted relayout work. Cap it at the
    // viewport bottom: the un-capped snap after the animation happens
    // entirely below the fold (invisible).
    const animHeight = (r: DOMRect): number =>
      r.top + r.height <= window.innerHeight
        ? r.height
        : Math.max(0, window.innerHeight - r.top);
    for (const el of this.objects.values()) {
      const firstRect = first.get(el);
      if (!firstRect) continue;
      const lastRect = el.getBoundingClientRect();
      // Anchor at the top-left corner: for equal-size circles this is
      // identical to center-to-center, but the active object grows
      // downward into its content height instead of flying off-screen.
      const dx = firstRect.left - lastRect.left;
      const dy = firstRect.top - lastRect.top;
      const frames: Keyframe[] = [
        {
          transform: `translate(${dx}px, ${dy}px)`,
          width: `${firstRect.width}px`,
          height: `${animHeight(firstRect)}px`,
        },
        {
          transform: 'translate(0, 0)',
          width: `${lastRect.width}px`,
          height: `${animHeight(lastRect)}px`,
        },
      ];
      if (el.classList.contains('focus-object--active')) {
        frames[0]!.borderRadius = '50%';
        frames[1]!.borderRadius = getComputedStyle(el).borderRadius;
      }
      const animation = el.animate(frames, {
        duration: reduced ? 0 : MORPH_MS,
        easing: MORPH_EASING,
      });
      animations.push(animation.finished.catch(() => undefined));
    }
    await Promise.all(animations);
  }

  private measureAll(): Map<HTMLElement, DOMRect> {
    // Force a synchronous layout so rects reflect the current grid state.
    void this.grid.offsetHeight;
    const rects = new Map<HTMLElement, DOMRect>();
    for (const el of this.objects.values()) {
      rects.set(el, el.getBoundingClientRect());
    }
    return rects;
  }

  private async ensureSurface(
    def: FocusDomainDef
  ): Promise<FocusDomainSurface> {
    let surface = this.surfaces.get(def.id);
    if (!surface && def.createSurface) {
      surface = await def.createSurface();
      this.surfaces.set(def.id, surface);
    }
    return surface as FocusDomainSurface;
  }
}
