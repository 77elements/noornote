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

export class FocusStage {
  private root: HTMLElement;
  private grid!: HTMLElement;
  private objects = new Map<string, HTMLElement>();
  private surfaces = new Map<string, FocusDomainSurface>();
  /** Side stacks while a domain is focused (see reparentSideStacks). */
  private sideStacks: [HTMLElement, HTMLElement] | null = null;
  private activeId: string | null = null;
  private morphing = false;
  private onResize = (): void => {
    // Breakpoint crossings while a column is open break the inline grid
    // placement — close silently instead of morphing across layouts.
    if (this.activeId) this.close({ animate: false });
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
      <button type="button" class="focus-object__control"
        aria-label="${_('Close')}">
        <svg width="12" height="12" aria-hidden="true"><use href="#icon-close"/></svg>
      </button>
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
    this.objects.set(def.id, el);
    return el;
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
    // cached so reopening does not refetch everything.
    const surface = this.surfaces.get(def.id);
    if (surface) {
      surface.view?.pause?.();
      surface.element.remove();
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
    for (const def of FOCUS_DOMAINS) {
      const circle = this.objects.get(def.id);
      if (circle && circle.parentElement !== this.grid) {
        this.grid.appendChild(circle);
      }
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
