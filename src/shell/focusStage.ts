/**
 * Focus Stage (v2) — builds the FS grid of primary domain circles inside
 * #focus-stage and owns the unified morph logic: clicking a circle grows
 * it into the center column (600px surface + actions rail), the other
 * circles shift aside, the
 * domain surface mounts BEFORE the morph — document flow: the column
 * height is its content height, so the FLIP animates to the laid-out
 * final geometry. The close control reverses the morph and restores the
 * grid.
 *
 * Morph technique: FLIP on the real elements via the Web Animations API.
 * The grid switches to `1fr calc(600px + $gap + 30px) 1fr` and every object animates from its
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
import { Tooltip } from '../components/ui/Tooltip';
import { Router } from '../services/Router';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';
import { NotificationsBadgeManager } from '../components/layout/managers/NotificationsBadgeManager';
import { DMBadgeManager } from '../components/layout/managers/DMBadgeManager';
import { ListsCountManager } from '../components/layout/managers/ListsCountManager';
import {
  FOCUS_DOMAINS,
  type FocusDomainDef,
  type FocusDomainSurface,
  type FocusSettingsDrawer,
  type FocusSettingsView,
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

/** A view type handed across objects: open this detail in the new column.
 *  param is optional — param-less view types (e.g. the composer) route to
 *  the target surface's secondary detail. */
interface FocusHandoff {
  viewType: string;
  param?: string;
}

/**
 * Unread diodes on the circles (v1 nn-wheel parity): notifications, DMs
 * and unread bookmarks. Same badge classes + SAME badge managers as the
 * classic nav drive them (wired in mount), shown whenever unread exists —
 * always rendered, no hover gating like the move handle.
 */
const DIODES: Record<string, string> = {
  notifications:
    '<span class="notifications-badge focus-object__diode"></span>',
  messages:
    '<span class="badge badge--green dm-badge focus-object__diode" style="display: none"></span>',
  bookmarks:
    '<span class="notifications-badge focus-object__diode" data-list-unread="bookmarks"></span>',
};

export class FocusStage {
  private root: HTMLElement;
  private grid!: HTMLElement;
  private objects = new Map<string, HTMLElement>();
  private surfaces = new Map<string, FocusDomainSurface>();
  /**
   * Circle order — registry order by default, user-adjustable via drag &
   * drop on the circles' move handles (drop on another circle SWAPS the
   * two positions), persisted per account. Drives the grid DOM order and
   * the side-stack distribution (see reparentSideStacks).
   */
  private order: string[] = [];
  /**
   * Circle arrangement in the focused layout (FV), explicit per-column
   * positions. null = alternating distribution derived from the SV order.
   * Independent of `order` (SV grid) — FV drags never touch the SV.
   * Persisted per account (FOCUS_UI_COLUMN_LAYOUT); later secondary
   * objects (widgets) join the same lists.
   */
  private columnLayout: { left: string[]; right: string[] } | null =
    this.loadColumnLayout();
  /** Unread-diode drivers (v1 badge managers over the shell's diodes). */
  private badgeManagers: Array<{
    destroy(): void;
  }> = [];
  /** Tooltip disposers for the persistent 30px controls (destroy contract). */
  private tooltipDisposers: Array<() => void> = [];
  /** Side stacks while a domain is focused (see reparentSideStacks). */
  private sideStacks: [HTMLElement, HTMLElement] | null = null;
  private activeId: string | null = null;
  private morphing = false;
  /** Per-object scroll-to-top action state (button + last scroll source). */
  private scrollTopState = new Map<
    string,
    { btn: HTMLElement; source: HTMLElement | null }
  >();
  /** Object-level history (def ids; back walks it, close removes). */
  private hist: string[] = [];
  /** ED-b bottom drawer (object settings), injected by the shell. */
  private drawer: FocusSettingsDrawer | null = null;
  private settingsView: FocusSettingsView | null = null;
  private settingsDef: FocusDomainDef | null = null;
  private settingsHost: HTMLElement | null = null;
  /** True while the panel came from the surface's secondary detail. */
  private settingsFromSecondary = false;
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
    this.order = this.loadOrder();
    for (const id of this.order) {
      const def = FOCUS_DOMAINS.find(d => d.id === id);
      if (def) this.grid.appendChild(this.createObject(def));
    }
    this.root.appendChild(this.grid);
    window.addEventListener('resize', this.onResize);
    this.setupBadgeManagers();
  }

  /**
   * Wire the SAME badge managers the classic nav uses to the shell's
   * diode spans (notifications / DMs / unread bookmarks). Scoped to the
   * grid; destroyed on shell unmount.
   */
  private setupBadgeManagers(): void {
    const notif = this.grid.querySelector(
      '.notifications-badge:not([data-list-unread])'
    ) as HTMLElement | null;
    const dm = this.grid.querySelector('.dm-badge') as HTMLElement | null;
    if (notif) this.badgeManagers.push(new NotificationsBadgeManager(notif));
    if (dm) this.badgeManagers.push(new DMBadgeManager(dm));
    this.badgeManagers.push(new ListsCountManager(this.grid));
  }

  /**
   * The persisted circle order, validated against the registry: stale ids
   * dropped, unknown domains appended in registry order — the array is
   * always a permutation of FOCUS_DOMAINS.
   */
  private loadOrder(): string[] {
    const ids = FOCUS_DOMAINS.map(d => d.id);
    const stored = PerAccountLocalStorage.getInstance().get<string[] | null>(
      StorageKeys.FOCUS_UI_ORDER,
      null
    );
    if (!Array.isArray(stored)) return ids;
    const valid = stored.filter(id => ids.includes(id));
    return [...valid, ...ids.filter(id => !valid.includes(id))];
  }

  /** Registry defs in the user's stored order. */
  private orderedDefs(): FocusDomainDef[] {
    return this.order
      .map(id => FOCUS_DOMAINS.find(d => d.id === id))
      .filter((d): d is FocusDomainDef => !!d);
  }

  /**
   * The persisted FV column layout, validated against the registry: stale
   * ids dropped, duplicates removed, an id listed in BOTH columns kept
   * only in 'left'. Null when nothing (or a broken shape) is stored —
   * callers derive the alternating default.
   */
  private loadColumnLayout(): { left: string[]; right: string[] } | null {
    const ids = FOCUS_DOMAINS.map(d => d.id);
    const stored = PerAccountLocalStorage.getInstance().get<{
      left: string[];
      right: string[];
    } | null>(StorageKeys.FOCUS_UI_COLUMN_LAYOUT, null);
    if (
      !stored ||
      !Array.isArray(stored.left) ||
      !Array.isArray(stored.right)
    ) {
      return null;
    }
    const clean = (list: string[], skip: string[]): string[] => [
      ...new Set(list.filter(id => ids.includes(id) && !skip.includes(id))),
    ];
    const left = clean(stored.left, []);
    const right = clean(stored.right, left);
    if (left.length === 0 && right.length === 0) return null;
    return { left, right };
  }

  /**
   * The arrangement to render RIGHT NOW: the persisted column layout or,
   * when none is stored, alternating 50/50 — with registry additions since
   * the layout was saved interleaved by their SV position (even index →
   * left), so every circle always has a home and the default derivation
   * stays stable. Always returns fresh arrays (callers mutate the result).
   */
  private effectiveLayout(): { left: string[]; right: string[] } {
    const base = this.columnLayout ?? {
      left: [] as string[],
      right: [] as string[],
    };
    const left = [...base.left];
    const right = [...base.right];
    this.orderedDefs().forEach((def, i) => {
      if (left.includes(def.id) || right.includes(def.id)) return;
      (i % 2 === 0 ? left : right).push(def.id);
    });
    return { left, right };
  }

  /** Full teardown (shell unmount): destroy every cached surface. */
  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.onSettingsClosed();
    this.drawer?.setOnClosed(null);
    this.drawer = null;
    for (const surface of this.surfaces.values()) {
      surface.view?.destroy?.();
    }
    this.surfaces.clear();
    this.objects.clear();
    this.scrollTopState.clear();
    this.hist = [];
    for (const mgr of this.badgeManagers) mgr.destroy();
    this.badgeManagers = [];
    for (const dispose of this.tooltipDisposers) dispose();
    this.tooltipDisposers = [];
    this.grid?.remove();
  }

  /**
   * Re-open a domain's surface from its route (boot/reload restore): the
   * URL is already correct, the surface opens with the standard morph.
   */
  restoreDomain(def: FocusDomainDef): void {
    void this.switchTo(def);
  }

  /**
   * Wire the ED-b bottom drawer (the shell owns it; the stage mounts the
   * per-object settings panel into its panel on the gear action).
   */
  bindSettingsDrawer(drawer: FocusSettingsDrawer): void {
    this.drawer = drawer;
    // Any close path (tab click, drag snap, programmatic close) tears the
    // mounted panel down and clears the gear's active state.
    drawer.setOnClosed(() => this.onSettingsClosed());
  }

  /**
   * The gear action: open the ED-b bottom drawer with this object's
   * settings panel. Toggle — clicking again closes via the drawer.
   * While the active surface shows its secondary detail (e.g. the
   * composer), the surface can swap in its own panel
   * (getSettingsForCurrentState) — Timeline settings only in /timeline.
   */
  private async toggleSettings(
    def: FocusDomainDef,
    btn: HTMLElement
  ): Promise<void> {
    if (!this.drawer) return;
    if (this.settingsView) {
      this.drawer.close();
      return;
    }
    const surface = this.surfaces.get(def.id);
    let settings: FocusSettingsView | null = null;
    if (surface?.view?.getSettingsForCurrentState) {
      settings = await surface.view.getSettingsForCurrentState();
    }
    if (!settings && !def.createSettings) return;
    const host = document.createElement('div');
    host.className = 'focus-settings';
    this.settingsHost = host;
    this.settingsDef = def;
    this.settingsView = settings ?? def.createSettings!();
    this.settingsFromSecondary = !!settings;
    this.drawer.panel.appendChild(host);
    this.settingsView.mount(host);
    this.drawer.open();
    btn.classList.add('is-active');
  }

  /** Drawer closed (any way): tear the settings panel down. */
  private onSettingsClosed(): void {
    if (this.settingsDef) {
      this.objects
        .get(this.settingsDef.id)
        ?.querySelector('.focus-object__settings')
        ?.classList.remove('is-active');
    }
    this.settingsView?.destroy();
    this.settingsView = null;
    this.settingsHost?.remove();
    this.settingsHost = null;
    this.settingsFromSecondary = false;
    this.settingsDef = null;
  }

  /**
   * Focus navigation seam: hand a view type to the ACTIVE surface's
   * column (e.g. a note click in the timeline). When the active surface
   * declines (or nothing is focused), the domain that OWNS the view type
   * takes over: the focus switches to it (one morph) and the detail
   * opens there — e.g. a quoted-article click inside the timeline morphs
   * to the Articles object with the article already in the column.
   * Returns false only when no domain owns the type — the caller
   * (ViewNavigationController) then navigates the classic way.
   */
  handleFocusNav(viewType: string, param?: string): boolean {
    if (this.activeId) {
      const surface = this.surfaces.get(this.activeId);
      if (surface?.view?.handleFocusNav?.(viewType, param)) return true;
    }
    if (this.morphing) return false;
    const def = FOCUS_DOMAINS.find(d => d.viewTypes?.includes(viewType));
    if (!def?.createSurface) return false;
    void this.switchTo(def, param ? { viewType, param } : { viewType });
    return true;
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
      <button type="button" class="focus-object__move" aria-label="${_('Reorder')}">
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-move"/></svg>
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
        ${
          def.createSettings
            ? `
        <button type="button" class="focus-object__settings"
          aria-label="${_('Settings')}">
          <svg width="15" height="15" aria-hidden="true"><use href="#icon-settings"/></svg>
        </button>`
            : ''
        }
      </div>
      ${DIODES[def.id] ?? ''}
      <div class="focus-object__surface"></div>
    `;
    el.addEventListener('click', () => void this.onObjectClick(def));
    // Move handle: pointer drag reorders the circles (drop on another
    // circle swaps the two positions, persisted per account). The handle
    // click itself must never open the object.
    const moveBtn = el.querySelector('.focus-object__move') as HTMLElement;
    moveBtn.addEventListener('click', e => e.stopPropagation());
    moveBtn.addEventListener('pointerdown', e => {
      if (this.morphing) return;
      if (this.activeId) {
        // Focused (FV): only side-stack circles drag — the active one keeps
        // its slot in the center column.
        if (def.id !== this.activeId) this.startColumnDrag(e, def.id, el);
        return;
      }
      this.startOrderDrag(e, def.id, el);
    });
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
      if (detail?.visible) {
        // A detail opened from THIS surface's own list (the handoff's
        // setBackVisible fires detached and never reaches here) becomes
        // its own history entry — back returns to the list, not past
        // it. Unconditional push: the top entry is the list state the
        // detail was opened from (same object id, different state).
        this.hist.push(def.id);
      } else if (
        !detail?.visible &&
        this.settingsDef?.id === def.id &&
        this.settingsFromSecondary
      ) {
        // The secondary detail closed (e.g. composer posted/cancelled):
        // its settings panel is state-specific — close the drawer with it.
        this.drawer?.close();
      }
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
      // History-aware back: pop the current state; the previous entry
      // is either another object (morph back — its surface state was
      // preserved on the way in) or this object's own list (in-column
      // back). At the history root the surface's list back no-ops.
      if (this.hist.length > 1) {
        this.hist.pop();
        const targetId = this.hist[this.hist.length - 1];
        if (targetId === def.id) {
          this.surfaces.get(def.id)?.view?.back?.();
          return;
        }
        const target = FOCUS_DOMAINS.find(d => d.id === targetId);
        if (target) {
          void this.switchTo(target, undefined, true);
          return;
        }
      }
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

    // Settings action (gear): opens the ED-b bottom drawer with THIS
    // object's settings panel (def.createSettings decides visibility).
    if (def.createSettings) {
      const settingsBtn = el.querySelector(
        '.focus-object__settings'
      ) as HTMLElement;
      settingsBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (this.activeId !== def.id || this.morphing) return;
        void this.toggleSettings(def, settingsBtn);
      });
    }
    // Tooltips on every 30px control (nn-tooltip, shared popup portalled
    // to <body>). The aria-label texts already describe the actions —
    // reuse them. Disposers tracked for the destroy contract.
    const tips: Array<[string, HTMLElement | null]> = [
      [_('Reorder'), moveBtn],
      [_('Close'), control],
      [_('Back'), backBtn],
      [_('Scroll to top'), scrollTopBtn],
      [
        _('Settings'),
        el.querySelector('.focus-object__settings') as HTMLElement | null,
      ],
    ];
    for (const [text, btn] of tips) {
      if (btn) this.tooltipDisposers.push(Tooltip.attach(btn, text));
    }
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

  private async onObjectClick(def: FocusDomainDef): Promise<void> {
    if (this.morphing) return; // a morph is running — ignore stray clicks
    if (!def.createSurface) return; // placeholder domain, no surface yet
    if (this.activeId === def.id) return; // active body — close lives on the control
    await this.switchTo(def);
  }

  /**
   * Object-to-object switch (also the cross-object seam entry): swap
   * the focus to another domain in ONE morph — the old object shrinks
   * back to its circle while the new one grows into the column. The
   * optional handoff opens a detail on the new surface before the
   * morph, so the column lands on its final content (e.g. the quoted
   * article clicked inside the timeline).
   */
  private async switchTo(
    def: FocusDomainDef,
    nav?: FocusHandoff,
    viaBack = false
  ): Promise<void> {
    const el = this.objects.get(def.id);
    if (!el || !def.createSurface) return;
    if (this.activeId === def.id) {
      // Already focused: only the handoff matters (e.g. an article link
      // clicked while the Articles object is open).
      if (nav) {
        this.surfaces
          .get(def.id)
          ?.view?.handleFocusNav?.(nav.viewType, nav.param);
      }
      return;
    }
    // History: every forward activation pushes (back walks without
    // pushing).
    if (!viaBack && this.hist[this.hist.length - 1] !== def.id) {
      this.hist.push(def.id);
    }
    await this.open(def, el, nav);
  }

  private async open(
    def: FocusDomainDef,
    el: HTMLElement,
    nav?: FocusHandoff
  ): Promise<void> {
    // Column content switches — object settings (ED-b) belong to the old
    // object and follow it out.
    if (this.settingsView) this.drawer?.close();
    // Object-to-object switch: capture the old object up front — it is
    // torn down inside the mutation phase below, so one FLIP pass
    // animates the old object back to its circle while the new one
    // grows into the column (no route detour through the home grid).
    const oldId = this.activeId !== def.id ? this.activeId : null;
    const oldEl = oldId ? this.objects.get(oldId) : undefined;
    const oldSurface = oldId ? this.surfaces.get(oldId) : undefined;

    this.morphing = true;
    this.activeId = def.id;
    const takeOver = window.matchMedia(MORPH_MIN_QUERY).matches;

    // Surface mounts BEFORE the morph: in document flow the column height
    // is its content height — the FLIP needs the laid-out final geometry.
    // A handoff detail is created first too (into the still-detached
    // frame), so the column grows with the final content instead of a
    // list that swaps away a moment later.
    const surface = await this.ensureSurface(def);
    if (this.activeId !== def.id) {
      this.morphing = false; // closed again while loading
      return;
    }
    if (nav) {
      if (surface.view?.openDetail) {
        try {
          await surface.view.openDetail(nav.param);
          // The frame's setBackVisible event was dispatched while the
          // frame was still detached (handoff runs before appendChild) —
          // the object's back action is wired via that event, so set it
          // here.
          const backBtn = el.querySelector(
            '.focus-object__back'
          ) as HTMLElement;
          if (backBtn) backBtn.hidden = false;
        } catch {
          // Handoff failed (e.g. detail import) — fall back to the list
          // and its URL instead of bricking the morph.
          surface.view?.syncUrl?.();
        }
      } else {
        // Object-root seam nav (no detail — e.g. 'tribes' from the TV
        // tab row): a deliberate object switch — the URL follows the
        // domain route like a circle click would.
        if (surface.view?.syncUrl) surface.view.syncUrl();
        else if (def.route) Router.getInstance().replaceUrl(def.route);
      }
    }

    // Measure the TRUE before-geometry: the old object is still the
    // column, the new one still a circle.
    const first = takeOver ? null : this.measureAll();

    // Mutation phase (one task — no paint in between): swap the focus.
    if (oldId) {
      if (oldSurface) {
        // Ephemeral surfaces (on-demand addon objects) die on switch —
        // leaving the object unloads the addon runtime.
        if (oldSurface.ephemeral) {
          oldSurface.view?.destroy?.();
          this.surfaces.delete(oldId);
        } else {
          oldSurface.view?.pause?.();
          // Handoff switch: the old object keeps its full state (list OR
          // detail) — back returns to exactly what the user came from.
          // Deliberate switches (circle click) reset it to the list.
          if (!nav) {
            oldSurface.view?.reset?.();
          }
        }
        oldSurface.element.remove();
      }
      // The old column is gone — reset its scroll-to-top action for a
      // clean reopen (same contract as close()).
      const oldSt = this.scrollTopState.get(oldId);
      if (oldSt) {
        oldSt.source = null;
        oldSt.btn.hidden = true;
      }
      if (oldEl) {
        oldEl.classList.remove('focus-object--active');
        oldEl.style.gridColumn = '';
      }
      this.restoreSideCircles();
    }

    const slot = el.querySelector('.focus-object__surface') as HTMLElement;
    slot.appendChild(surface.element);
    surface.view?.resume?.();
    el.classList.add('focus-object--active');
    this.grid.classList.add('is-focused');
    if (!takeOver) {
      // The side circles re-parent into per-side stacks so their rows
      // stay compact while the active column's content height stretches
      // the middle row (in flow → the page scrolls the column).
      el.style.gridColumn = '2';
      this.reparentSideStacks(def.id);
    }
    // A reopened (cached) surface may already be scrolled — sync the
    // scroll-to-top action to the restored state.
    const st = this.scrollTopState.get(def.id);
    if (st) {
      st.source = this.findMainScroller(slot);
      st.btn.hidden = !(
        st.source && st.source.scrollTop > SCROLL_TOP_THRESHOLD
      );
    }

    // URL follows the restored state (in place, no history entry): a
    // handoff's detail set its own URL already; otherwise the surface
    // syncs — a preserved detail keeps its route — falling back to the
    // domain route.
    if (!nav) {
      if (surface.view?.syncUrl) surface.view.syncUrl();
      else if (def.route) Router.getInstance().replaceUrl(def.route);
    }

    let morphDone: Promise<unknown> = Promise.resolve();
    if (first) morphDone = this.flipAll(first); // null = takeover, no FLIP

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
    // Object settings (ED-b) die with their object.
    if (this.settingsView) this.drawer?.close();

    // Capture the focused geometry FIRST (content still mounted): in
    // document flow the column height is its content — after the surface
    // detaches, the box collapses and the morph-back would start from a
    // sliver.
    const first = animate && !takeOver ? this.measureAll() : null;

    // Detach the surface first: the view pauses, its element is kept
    // cached so reopening does not refetch everything. The surface
    // returns to its list state — reopening never shows a stale detail.
    // Ephemeral surfaces (on-demand addon objects) are destroyed and
    // evicted instead — leaving the object unloads the addon runtime.
    const surface = this.surfaces.get(def.id);
    if (surface) {
      if (surface.ephemeral) {
        surface.view?.destroy?.();
        this.surfaces.delete(def.id);
      } else {
        surface.view?.pause?.();
        surface.view?.reset?.();
      }
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
    // The object left the history: its surface was reset above (a
    // reopen starts at the list), so its history entries are gone too.
    this.hist = this.hist.filter(id => id !== def.id);
    this.restoreSideCircles();
    if (!first) return; // takeover / no-animate: plain class flip

    // FLIP back: focused geometry → circle geometry.
    this.morphing = true;
    void this.flipAll(first).then(() => {
      this.morphing = false;
    });
  }

  /**
   * Pointer drag on a circle's move handle (grid state only — never while
   * a domain is focused or a morph runs). The circle follows the cursor
   * visually; the circle under the pointer is highlighted as the drop
   * target. Dropping on another circle swaps the two ids in the stored
   * order and persists it. A few pixels of dead zone keep a shaky click
   * from becoming a drag.
   */
  private startOrderDrag(
    e: PointerEvent,
    dragId: string,
    el: HTMLElement
  ): void {
    if (this.activeId || this.morphing) return;
    e.stopPropagation();
    e.preventDefault(); // no text selection / native drag while moving
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let target: HTMLElement | null = null;

    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        // pointer-events off: the translated circle must not shadow the
        // drop target in elementFromPoint.
        el.classList.add('is-drag-source');
      }
      el.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const obj = hit?.closest('.focus-object') as HTMLElement | null;
      const next = obj && obj !== el && obj.dataset.domainId ? obj : null;
      if (next !== target) {
        target?.classList.remove('is-drop-target');
        next?.classList.add('is-drop-target');
        target = next;
      }
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      el.classList.remove('is-drag-source');
      el.style.transform = '';
      target?.classList.remove('is-drop-target');
    };
    const onUp = (): void => {
      const dropId = target?.dataset.domainId;
      cleanup();
      if (dropId) this.swapOrder(dragId, dropId);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
  }

  /**
   * Pointer drag on a side stack's move handle (focused state only).
   * Dragging it toward the OPPOSITE stack highlights that stack as the
   * drop zone; dropping there moves ALL circles into it — in the user's
   * stored order — and persists the side (the source column empties as
   * the future secondary-widget area). Same dead-zone mechanics as
   * startOrderDrag.
   */
  private startStackDrag(
    e: PointerEvent,
    side: 'left' | 'right',
    icon: HTMLElement
  ): void {
    if (this.morphing || !this.sideStacks) return;
    e.stopPropagation();
    e.preventDefault(); // no text selection / native drag while moving
    const targetEl = side === 'left' ? this.sideStacks[1] : this.sideStacks[0];
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let over = false;

    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        // pointer-events off: the translated icon must not shadow the
        // drop zone in elementFromPoint.
        icon.classList.add('is-drag-source');
        targetEl.classList.add('is-dropzone');
      }
      icon.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      over = !!hit && hit.closest('.focus-side-stack') === targetEl;
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      icon.classList.remove('is-drag-source');
      icon.style.transform = '';
      targetEl.classList.remove('is-dropzone');
    };
    const onUp = (): void => {
      const drop = over;
      cleanup();
      if (drop) this.moveAllCircles(side === 'left' ? 'right' : 'left');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
  }

  /**
   * Pointer drag on a side-stack circle's move handle (focused state).
   * The circle is lifted OUT of its stack (position: fixed — the stack's
   * overflow clipping would otherwise cut the visual mid-flight) and
   * follows the cursor; its slot closes up and an insertion line marks the
   * exact drop position in BOTH columns: above all circles (column top,
   * later the widget slot) or between two circles. Dropping writes the new
   * per-column arrangement to FOCUS_UI_COLUMN_LAYOUT — the SV grid order
   * is untouched — and re-distributes. Same dead-zone mechanics as
   * startOrderDrag.
   */
  private startColumnDrag(
    e: PointerEvent,
    dragId: string,
    el: HTMLElement
  ): void {
    if (this.morphing || !this.sideStacks) return;
    e.stopPropagation();
    e.preventDefault(); // no text selection / native drag while moving
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    let dragging = false;
    let line: HTMLElement | null = null;
    let target: { stack: HTMLElement; index: number } | null = null;

    // Insertion line into the target stack at the boundary of `index`
    // (0 = above the first visible circle). Absolute inside the stack, so
    // no grid rows shift while it moves; coordinates are content-space
    // (scroll-aware).
    const placeLine = (t: { stack: HTMLElement; index: number }): void => {
      const stackRect = t.stack.getBoundingClientRect();
      const scrollTop = t.stack.scrollTop;
      const circles = (
        [...t.stack.querySelectorAll('.focus-object')] as HTMLElement[]
      ).filter(c => !c.classList.contains('is-column-drag'));
      const halfGap = parseFloat(getComputedStyle(t.stack).rowGap) / 2 || 0;
      let y: number;
      if (circles.length === 0) {
        const tools = t.stack.querySelector(
          '.focus-side-stack__tools'
        ) as HTMLElement | null;
        y = tools
          ? tools.getBoundingClientRect().bottom -
            stackRect.top +
            scrollTop +
            halfGap
          : halfGap;
      } else if (t.index >= circles.length) {
        const last = circles[circles.length - 1];
        if (!last) return;
        const r = last.getBoundingClientRect();
        y = r.bottom - stackRect.top + scrollTop + halfGap;
      } else {
        const next = circles[t.index];
        if (!next) return;
        const r = next.getBoundingClientRect();
        y = r.top - stackRect.top + scrollTop - halfGap;
      }
      if (!line) {
        line = document.createElement('div');
        line.className = 'focus-side-stack__drop-line';
        t.stack.appendChild(line);
      }
      line.style.top = `${y - 1}px`; // -1: center the 2px line on the boundary
      if (line.parentElement !== t.stack) t.stack.appendChild(line);
    };

    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        // Fixed lift: escapes the stack's overflow clipping; the hole in
        // the source column closes (the insertion line takes its place).
        el.classList.add('is-drag-source', 'is-column-drag');
        el.style.position = 'fixed';
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.width = `${rect.width}px`;
        el.style.height = `${rect.height}px`;
      }
      el.style.left = `${ev.clientX - grabX}px`;
      el.style.top = `${ev.clientY - grabY}px`;
      const next = this.columnDropTarget(ev.clientX, ev.clientY);
      if (
        !!next !== !!target ||
        (next &&
          target &&
          (next.stack !== target.stack || next.index !== target.index))
      ) {
        line?.remove();
        line = null;
        if (next) placeLine(next);
        target = next;
      }
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      el.classList.remove('is-drag-source', 'is-column-drag');
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
      line?.remove();
      line = null;
    };
    const onUp = (): void => {
      const t = target;
      cleanup();
      if (!t || !this.sideStacks) return;
      const side = t.stack === this.sideStacks[0] ? 'left' : 'right';
      this.moveCircleTo(dragId, side, t.index);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
  }

  /** Move ALL circles into the given stack (SV order), persist. */
  private moveAllCircles(side: 'left' | 'right'): void {
    if (!this.sideStacks || !this.activeId) return;
    const svOrder = this.orderedDefs().map(d => d.id);
    this.columnLayout = {
      left: side === 'left' ? svOrder : [],
      right: side === 'right' ? svOrder : [],
    };
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_COLUMN_LAYOUT,
      this.columnLayout
    );
    this.distributeSideCircles(
      this.sideStacks[0],
      this.sideStacks[1],
      this.activeId
    );
  }

  /**
   * Which side stack the pointer is over and at which VISIBLE position the
   * drop would insert (0 = above all circles of that column, circles.length
   * = below the last). Null when the pointer is outside both stacks. The
   * active circle never counts — it is not rendered in the stacks.
   */
  private columnDropTarget(
    x: number,
    y: number
  ): { stack: HTMLElement; index: number } | null {
    if (!this.sideStacks) return null;
    const hit = document.elementFromPoint(x, y);
    const stack = hit?.closest('.focus-side-stack') as HTMLElement | null;
    if (
      !stack ||
      (stack !== this.sideStacks[0] && stack !== this.sideStacks[1])
    )
      return null;
    // The lifted circle is still a DOM child of its source stack (fixed
    // positioning) — exclude it, it holds no drop position.
    const circles = (
      [...stack.querySelectorAll('.focus-object')] as HTMLElement[]
    ).filter(c => !c.classList.contains('is-column-drag'));
    for (let i = 0; i < circles.length; i++) {
      const circle = circles[i];
      if (!circle) continue;
      const r = circle.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { stack, index: i };
    }
    return { stack, index: circles.length };
  }

  /**
   * Move ONE circle to an exact position in a column (visible index,
   * 0 = above all circles of the target column) and persist. The index
   * counts the circles VISIBLE in the column — the active circle is skipped
   * when mapping it onto the underlying id lists (it holds its own slot).
   */
  private moveCircleTo(
    dragId: string,
    side: 'left' | 'right',
    index: number
  ): void {
    if (!this.sideStacks || !this.activeId) return;
    const activeId = this.activeId;
    const layout = this.effectiveLayout();
    const source = layout.left.includes(dragId) ? 'left' : 'right';
    const target = layout[side].filter(id => id !== dragId);
    // Map the visible insertion index onto the full id list (active slot
    // skipped): first position whose visible rank equals `index`.
    let insertAt = target.length;
    let seen = 0;
    for (let i = 0; i < target.length; i++) {
      if (target[i] === activeId) continue;
      if (seen === index) {
        insertAt = i;
        break;
      }
      seen++;
    }
    target.splice(insertAt, 0, dragId);
    if (source === side) {
      layout[side] = target;
    } else {
      layout[source] = layout[source].filter(id => id !== dragId);
      layout[side] = target;
    }
    this.columnLayout = { left: layout.left, right: layout.right };
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_COLUMN_LAYOUT,
      this.columnLayout
    );
    this.distributeSideCircles(
      this.sideStacks[0],
      this.sideStacks[1],
      activeId
    );
  }

  /**
   * Reset the column layout to the default alternating 50/50 (derived
   * from the SV order, starting LEFT) and clear the persisted layout.
   * Wired to the reset button next to each stack's move handle.
   */
  private resetStackSide(): void {
    if (!this.sideStacks || !this.activeId) return;
    this.columnLayout = null;
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_COLUMN_LAYOUT,
      null
    );
    this.distributeSideCircles(
      this.sideStacks[0],
      this.sideStacks[1],
      this.activeId
    );
  }

  /** Swap two ids in the stored order, persist, re-apply the grid order. */
  private swapOrder(a: string, b: string): void {
    if (a === b) return;
    const ia = this.order.indexOf(a);
    const ib = this.order.indexOf(b);
    if (ia < 0 || ib < 0) return;
    const idA = this.order[ia];
    const idB = this.order[ib];
    if (idA === undefined || idB === undefined) return;
    this.order[ia] = idB;
    this.order[ib] = idA;
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_ORDER,
      this.order
    );
    this.applyOrderToGrid();
  }

  /** Mirror the stored order into the grid DOM (grid state only). */
  private applyOrderToGrid(): void {
    if (this.activeId || this.morphing) return;
    for (const id of this.order) {
      const circle = this.objects.get(id);
      if (circle) this.grid.appendChild(circle);
    }
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
    left.innerHTML = this.stackMoveIcon('left');
    right.innerHTML = this.stackMoveIcon('right');
    for (const [stack, side] of [
      [left, 'left'],
      [right, 'right'],
    ] as const) {
      // The buttons must never open an object underneath.
      const tools = stack.querySelector(
        '.focus-side-stack__tools'
      ) as HTMLElement;
      tools.addEventListener('click', ev => ev.stopPropagation());
      const move = tools.querySelector(
        '.focus-side-stack__move'
      ) as HTMLElement;
      move.addEventListener('pointerdown', ev =>
        this.startStackDrag(ev, side, move)
      );
      tools
        .querySelector('.focus-side-stack__reset')
        ?.addEventListener('click', () => this.resetStackSide());
      // Stack tools live only while their stack exists (recreated per
      // focus, removed on close) — their listeners die with the elements,
      // so no disposer tracking is needed here. The move tooltip states
      // the drop DIRECTION: dragging it toward the other column.
      const stackTips: Array<[string, HTMLElement]> = [
        [
          side === 'left'
            ? _('Move all circles to the right column')
            : _('Move all circles to the left column'),
          move,
        ],
        [
          _('Distribute circles evenly'),
          tools.querySelector('.focus-side-stack__reset') as HTMLElement,
        ],
      ];
      for (const [text, btn] of stackTips) Tooltip.attach(btn, text);
    }
    this.distributeSideCircles(left, right, activeId);
    const active = this.objects.get(activeId) as HTMLElement;
    this.grid.insertBefore(left, active);
    this.grid.insertBefore(right, active.nextSibling);
    this.sideStacks = [left, right];
  }

  /** The stack's top tools: move handle (drag moves ALL circles) + reset. */
  private stackMoveIcon(side: 'left' | 'right'): string {
    return `<div class="focus-side-stack__tools">
      <button type="button" class="focus-side-stack__move" data-stack-side="${side}" aria-label="${_('Move all circles')}">
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-move"/></svg>
      </button>
      <button type="button" class="focus-side-stack__reset" aria-label="${_('Distribute circles evenly')}">
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-pull-refresh"/></svg>
      </button>
    </div>`;
  }

  /**
   * Fill the two stacks with the non-active circles, in the order of the
   * effective column layout (persisted FOCUS_UI_COLUMN_LAYOUT or the
   * alternating default). The ACTIVE circle is skipped: it stays in the
   * center column but KEEPS its slot in the layout, so it returns to its
   * position when the focus ends.
   */
  private distributeSideCircles(
    left: HTMLElement,
    right: HTMLElement,
    activeId: string
  ): void {
    const layout = this.effectiveLayout();
    for (const [stack, ids] of [
      [left, layout.left],
      [right, layout.right],
    ] as const) {
      for (const id of ids) {
        if (id === activeId) continue;
        const circle = this.objects.get(id);
        if (circle) stack.appendChild(circle);
      }
    }
  }

  /** Move the circles back into the grid (stored order) and drop the stacks. */
  private restoreSideCircles(): void {
    if (!this.sideStacks) return;
    // Append EVERY circle in the stored order — including the one that
    // stayed in the grid as the focused column. appendChild moves it, so
    // the original order is restored exactly; re-appending only the
    // stacked circles would place them all AFTER the formerly active
    // object and shuffle the grid.
    for (const def of this.orderedDefs()) {
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
