/**
 * Focus Shell (v2) — the mount layer for the Focus UI.
 *
 * Built from scratch, step by step ("operation on the open heart"): the
 * shell is a single-column, 100%-wide wrapper. Nothing from the classic
 * interface is reused or re-mounted here. Classic chrome is hidden by the
 * `html.ui--focus` CSS gate (styles/components/_focus-shell.scss) while
 * the shell owns the screen.
 *
 * Edge drawers (ED-t top / ED-b bottom — AGENTS.md shorthand): browser-tab
 * style handles at the top and bottom screen edge. Click (or drag on touch)
 * slides a panel in as an overlay ON TOP of the shell content — content is
 * never pushed aside. Panels are empty frames for now (green field); their
 * content comes later.
 *
 * TEMPORARY: the Focus-UI switch lives inside the ED-t panel so the user
 * is never locked into the shell. It moves out again as soon as Settings
 * gets its proper place inside the shell.
 *
 * Rescue hatch (dev): `?focusui=0` boots the classic interface even when
 * the flag is on (see helpers/focusUiSetting.ts).
 */

import { Switch } from '../components/ui/Switch';
import { isFocusUiEnabled, setFocusUiEnabled } from '../helpers/focusUiSetting';
import { setFocusUiNavHandler } from '../helpers/focusUiNavigation';
import { LayoutService } from '../services/LayoutService';
import { Router } from '../services/Router';
import { ToastService } from '../services/ToastService';
import { TypedEventBus } from '../core/TypedEventBus';
import { FocusStage } from './focusStage';
import { FOCUS_DOMAINS } from './focusDomains';
import { _ } from '../i18n';

const SHELL_ID = 'focus-shell';
/** Movement beyond this many px counts as a drag, below it as a click. */
const CLICK_SLOP_PX = 6;
/** Live stage instance — cleaned up on shell unmount. */
let stage: FocusStage | null = null;

/** Drawer ids — ED-t (top) / ED-b (bottom), see AGENTS.md abbreviations. */
type EdgeDrawerId = 'ed-t' | 'ed-b';

const clamp = (v: number, min: number, max: number): number =>
  Math.min(Math.max(v, min), max);

/**
 * One slide-in panel at a screen edge with a browser-tab handle.
 * Instances: ED-t (top) / ED-b (bottom). Panel heights live ONLY in
 * _focus-shell.scss (--panel-h) — this class reads them at mount time.
 *
 * Geometry (see _focus-shell.scss): the drawer box is the panel; the tab
 * is absolutely positioned OUTSIDE the box (negative offset), so the
 * closed transform (translateY(±100%)) parks the panel off-screen while
 * the tab stays visible at the screen edge. Open, the tab sits merged on
 * the panel frame like a folder tab.
 */
class EdgeDrawer {
  private root!: HTMLElement;
  private tab!: HTMLButtonElement;
  private open = false;
  private activePointer: number | null = null;
  private startY = 0;
  private hasMoved = false;
  private lastOffset = 0;
  private panelHeight: number;

  constructor(
    private readonly id: EdgeDrawerId,
    fallbackPanelHeight: number
  ) {
    this.panelHeight = fallbackPanelHeight;
  }

  private get edge(): 'top' | 'bottom' {
    return this.id === 'ed-t' ? 'top' : 'bottom';
  }

  mount(
    parent: HTMLElement,
    decoratePanel?: (panel: HTMLElement) => void
  ): void {
    this.root = document.createElement('div');
    this.root.id = this.id;
    this.root.className = `focus-drawer focus-drawer--${this.edge}`;
    const label = this.edge === 'top' ? _('Top panel') : _('Bottom panel');
    this.root.innerHTML = `
      <div class="focus-drawer__panel" role="region" aria-label="${label}"></div>
      <button type="button" class="focus-drawer__tab"
        aria-label="${label}" aria-expanded="false"></button>
    `;
    if (decoratePanel) {
      const panel = this.root.querySelector(
        '.focus-drawer__panel'
      ) as HTMLElement;
      decoratePanel(panel);
    }
    this.tab = this.root.querySelector(
      '.focus-drawer__tab'
    ) as HTMLButtonElement;
    this.tab.addEventListener('pointerdown', this.onPointerDown);
    this.tab.addEventListener('pointermove', this.onPointerMove);
    this.tab.addEventListener('pointerup', this.onPointerUp);
    this.tab.addEventListener('pointercancel', this.onPointerCancel);
    parent.appendChild(this.root);
    // Sync the drag math with the stylesheet (constructor value is only a
    // fallback in case the custom property ever fails to resolve).
    const cssHeight = parseFloat(
      getComputedStyle(this.root).getPropertyValue('--panel-h')
    );
    if (Number.isFinite(cssHeight) && cssHeight > 0) {
      this.panelHeight = cssHeight;
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.activePointer !== null) return;
    this.activePointer = e.pointerId;
    this.startY = e.clientY;
    this.hasMoved = false;
    this.lastOffset = this.open ? 0 : this.panelHeight;
    // Synthetic pointers (tests) have no active pointer id to capture.
    try {
      this.tab.setPointerCapture(e.pointerId);
    } catch {
      /* dragging still works via the tab's own listeners */
    }
    this.root.classList.add('is-dragging');
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointer) return;
    const dy = e.clientY - this.startY;
    if (Math.abs(dy) > CLICK_SLOP_PX) this.hasMoved = true;
    if (!this.hasMoved) return;
    // Offset along the close direction: 0 = fully open, height = closed.
    const along = this.edge === 'bottom' ? dy : -dy;
    this.lastOffset = clamp(
      this.open ? along : this.panelHeight + along,
      0,
      this.panelHeight
    );
    this.root.style.transform = `translateY(${
      this.edge === 'bottom' ? this.lastOffset : -this.lastOffset
    }px)`;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.root.classList.remove('is-dragging');
    if (!this.hasMoved) {
      this.setOpen(!this.open); // plain click toggles
      return;
    }
    // Drag: snap to the nearer end state.
    this.setOpen(this.lastOffset < this.panelHeight / 2);
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.root.classList.remove('is-dragging');
    this.snapToState();
  };

  /** Clear the inline drag transform and animate back to the stored state. */
  private snapToState(): void {
    this.root.style.transform = '';
    this.root.classList.toggle('is-open', this.open);
    this.tab.setAttribute('aria-expanded', String(this.open));
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.snapToState();
  }
}

/** Mount the Focus Shell with edge drawers; ED-t hosts the TEMP switch. */
export function mountFocusShell(): void {
  if (document.getElementById(SHELL_ID)) return;
  const shell = document.createElement('div');
  shell.id = SHELL_ID;
  shell.className = 'focus-shell';

  // TEMPORARY switch — lives inside the ED-t panel until settings get
  // their place in the shell. Toggling OFF restores the classic interface.
  const switchBack = new Switch({
    label: _('Focus UI (v2)'),
    checked: isFocusUiEnabled(),
    onChange: checked => {
      if (!checked) {
        setFocusUiEnabled(false);
        TypedEventBus.getInstance().emit('settings:focus-ui-changed', {
          enabled: false,
        });
        // Back to the classic home: navigate('/') re-mounts the timeline
        // view (the shell may have left the URL anywhere).
        Router.getInstance().navigate('/', true);
        // Restore the classic layout classes immediately.
        void LayoutService.getInstance().refresh();
        ToastService.show(_('Classic interface active'), 'success');
      }
    },
  });
  const tempSwitchWrap = document.createElement('div');
  tempSwitchWrap.className = 'focus-shell__temp-switch';
  tempSwitchWrap.innerHTML = switchBack.render();
  switchBack.setupEventListeners(tempSwitchWrap);

  // The stage: the free central surface area under the ED overlays —
  // the FS grid of primary domain circles lands here.
  const stageEl = document.createElement('div');
  stageEl.id = 'focus-stage';
  stageEl.className = 'focus-stage';
  shell.appendChild(stageEl);

  // Brand watermark: the logo sits huge and faint BEHIND the home grid —
  // a start-screen flourish. Once a domain is focused, the center column
  // covers it and it fades out entirely.
  const brand = document.createElement('div');
  brand.className = 'focus-shell__brand';
  brand.innerHTML = `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <filter id="nn-engrave" x="-10%" y="-10%" width="120%" height="120%">
        <!-- Stamped-in look: crisp, barely blurred inner walls — dark wall
             on the inner top edge, sharp light catch on the inner bottom
             edge. Both rims are clipped to the mark's silhouette. -->
        <feOffset in="SourceAlpha" dx="0" dy="3" result="down"/>
        <feGaussianBlur in="down" stdDeviation="0.3" result="down-blur"/>
        <feComposite in="SourceAlpha" in2="down-blur" operator="out" result="top-rim"/>
        <feFlood flood-color="rgb(0 0 0 / 0.85)" result="dark"/>
        <feComposite in="dark" in2="top-rim" operator="in" result="dark-rim"/>
        <feOffset in="SourceAlpha" dx="0" dy="-3.5" result="up"/>
        <feGaussianBlur in="up" stdDeviation="0.3" result="up-blur"/>
        <feComposite in="SourceAlpha" in2="up-blur" operator="out" result="bot-rim"/>
        <feFlood flood-color="rgb(255 255 255 / 0.4)" result="light"/>
        <feComposite in="light" in2="bot-rim" operator="in" result="light-rim"/>
        <feMerge>
          <feMergeNode in="SourceGraphic"/>
          <feMergeNode in="dark-rim"/>
          <feMergeNode in="light-rim"/>
        </feMerge>
      </filter>
      <filter id="nn-engrave-icon" x="-20%" y="-20%" width="140%" height="140%">
        <!-- Same stamped-in look as #nn-engrave, tuned for the ~56px FS
             object icons (scaled offsets, boosted for small-size legibility). -->
        <feOffset in="SourceAlpha" dx="0" dy="1.3" result="down"/>
        <feGaussianBlur in="down" stdDeviation="0.25" result="down-blur"/>
        <feComposite in="SourceAlpha" in2="down-blur" operator="out" result="top-rim"/>
        <feFlood flood-color="rgb(0 0 0 / 0.9)" result="dark"/>
        <feComposite in="dark" in2="top-rim" operator="in" result="dark-rim"/>
        <feOffset in="SourceAlpha" dx="0" dy="-1.4" result="up"/>
        <feGaussianBlur in="up" stdDeviation="0.25" result="up-blur"/>
        <feComposite in="SourceAlpha" in2="up-blur" operator="out" result="bot-rim"/>
        <feFlood flood-color="rgb(255 255 255 / 0.7)" result="light"/>
        <feComposite in="light" in2="bot-rim" operator="in" result="light-rim"/>
        <feMerge>
          <feMergeNode in="SourceGraphic"/>
          <feMergeNode in="dark-rim"/>
          <feMergeNode in="light-rim"/>
        </feMerge>
      </filter>
    </svg>
    <svg class="focus-shell__brand-wheel" aria-hidden="true"><use href="#nn-logo"/></svg>`;
  stageEl.appendChild(brand);

  stage = new FocusStage(stageEl);
  stage.mount();

  // Edge drawers ED-b (bottom) and ED-t (top) as overlays — heights live
  // in SCSS (--panel-h) and are read at mount; numbers here are fallbacks.
  new EdgeDrawer('ed-b', 300).mount(shell);
  new EdgeDrawer('ed-t', 70).mount(shell, panel => {
    panel.appendChild(tempSwitchWrap);
  });

  document.getElementById('app')?.appendChild(shell);

  // The home grid IS '/'. A switch from a classic route (e.g. /settings/ui)
  // rewrites the URL in place — no view mounting, no history entry. But a
  // boot/reload ON a domain route (e.g. /timeline) restores that domain's
  // focused surface instead, so the address survives reloads.
  const bootPath = window.location.pathname;
  const bootDomain = FOCUS_DOMAINS.find(d => d.route === bootPath);
  if (bootDomain) {
    stage.restoreDomain(bootDomain);
  } else {
    Router.getInstance().replaceUrl('/');
  }

  // Focus navigation seam: while the shell lives, note/article clicks etc.
  // render inside the ACTIVE surface's column (see focusStage.handleFocusNav).
  setFocusUiNavHandler(
    (viewType, param) => stage?.handleFocusNav(viewType, param) ?? false
  );
}

/** Remove the Focus Shell (idempotent); tears down the stage surfaces. */
export function unmountFocusShell(): void {
  setFocusUiNavHandler(null);
  stage?.destroy();
  stage = null;
  document.getElementById(SHELL_ID)?.remove();
}
