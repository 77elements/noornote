/**
 * Focus Shell (v2) — the mount layer for the Focus UI.
 *
 * Built from scratch, step by step ("operation on the open heart"): the
 * shell is a single-column, 100%-wide wrapper. Nothing from the classic
 * interface is reused or re-mounted here. Classic chrome is hidden by the
 * `html.ui--focus` CSS gate (styles/components/_focus-shell.scss) while
 * the shell owns the screen.
 *
 * Edge drawers: browser-tab-style handles at the bottom and top screen
 * edge. Click (or drag on touch) slides a panel in as an overlay ON TOP
 * of the shell content — content is never pushed aside. Panels are empty
 * frames for now (green field); their content comes later.
 *
 * TEMPORARY: the shell currently also hosts the Focus-UI switch so the
 * user is never locked into the shell. This switch moves out again as
 * soon as Settings gets its proper place inside the shell.
 *
 * Rescue hatch (dev): `?focusui=0` boots the classic interface even when
 * the flag is on (see helpers/focusUiSetting.ts).
 */

import { Switch } from '../components/ui/Switch';
import { isFocusUiEnabled, setFocusUiEnabled } from '../helpers/focusUiSetting';
import { LayoutService } from '../services/LayoutService';
import { ToastService } from '../services/ToastService';
import { TypedEventBus } from '../core/TypedEventBus';
import { _ } from '../i18n';

const SHELL_ID = 'focus-shell';
/** Movement beyond this many px counts as a drag, below it as a click. */
const CLICK_SLOP_PX = 6;

const clamp = (v: number, min: number, max: number): number =>
  Math.min(Math.max(v, min), max);

/**
 * One slide-in panel at a screen edge with a browser-tab handle.
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

  constructor(
    private readonly edge: 'top' | 'bottom',
    private readonly panelHeight: number
  ) {}

  mount(parent: HTMLElement): void {
    this.root = document.createElement('div');
    this.root.className = `focus-drawer focus-drawer--${this.edge}`;
    const label = this.edge === 'top' ? _('Top panel') : _('Bottom panel');
    this.root.innerHTML = `
      <div class="focus-drawer__panel" role="region" aria-label="${label}"></div>
      <button type="button" class="focus-drawer__tab"
        aria-label="${label}" aria-expanded="false"></button>
    `;
    this.tab = this.root.querySelector(
      '.focus-drawer__tab'
    ) as HTMLButtonElement;
    this.tab.addEventListener('pointerdown', this.onPointerDown);
    this.tab.addEventListener('pointermove', this.onPointerMove);
    this.tab.addEventListener('pointerup', this.onPointerUp);
    this.tab.addEventListener('pointercancel', this.onPointerCancel);
    parent.appendChild(this.root);
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

/** Mount the Focus Shell with its temporary switch and edge drawers. */
export function mountFocusShell(): void {
  if (document.getElementById(SHELL_ID)) return;
  const shell = document.createElement('div');
  shell.id = SHELL_ID;
  shell.className = 'focus-shell';

  const switchBack = new Switch({
    label: _('Focus UI (v2)'),
    checked: isFocusUiEnabled(),
    onChange: checked => {
      if (!checked) {
        setFocusUiEnabled(false);
        TypedEventBus.getInstance().emit('settings:focus-ui-changed', {
          enabled: false,
        });
        // Restore the classic layout classes immediately.
        void LayoutService.getInstance().refresh();
        ToastService.show(_('Classic interface active'), 'success');
      }
    },
  });
  shell.innerHTML = switchBack.render();
  switchBack.setupEventListeners(shell);

  // Edge drawers: bottom panel 300px, top panel 150px (overlay panels).
  new EdgeDrawer('bottom', 300).mount(shell);
  new EdgeDrawer('top', 150).mount(shell);

  document.getElementById('app')?.appendChild(shell);
}

/** Remove the Focus Shell (idempotent). */
export function unmountFocusShell(): void {
  document.getElementById(SHELL_ID)?.remove();
}
