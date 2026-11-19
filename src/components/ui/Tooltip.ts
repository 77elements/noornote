/**
 * Tooltip Component (nn-tooltip)
 *
 * Lightweight, reusable hover popup. Appears instantly when the pointer enters
 * a target element and disappears the moment it leaves (also on focus/blur for
 * keyboard users). A single shared popup node is portalled to <body> so it is
 * never clipped by an overflow:hidden ancestor and never inherits stacking
 * context from the target.
 *
 * Touch: tooltips only appear on a long-press of the element (a plain tap
 * never shows one — the synthetic mouse events browsers fire after a tap
 * are guarded), and the popup hides on release. Any pointer-down anywhere
 * hides the popup, so a tooltip never strands at its old position while
 * the target moves away (tab/drawer/handle taps move their elements).
 *
 * Central UI primitive in the spirit of Modal / NnDropdown: own .ts + .scss,
 * reusable anywhere. Styling lives in styles/components/_tooltip.scss.
 *
 * @example
 *   const dispose = Tooltip.attach(myCheckboxLabel, 'Explains the effect.');
 *   // on teardown:
 *   dispose();
 */

export type TooltipPlacement = 'top' | 'bottom';
export type TooltipAlign = 'center' | 'start' | 'end';

export interface TooltipOptions {
  /** Preferred placement relative to the target. Default: 'top'. */
  placement?: TooltipPlacement;
  /**
   * Horizontal alignment of the popup relative to the target.
   * - 'center' (default): popup centered on the target.
   * - 'start': popup's left edge aligns with the target's left edge.
   * - 'end': popup's right edge aligns with the target's right edge.
   */
  align?: TooltipAlign;
}

export class Tooltip {
  private static popup: HTMLElement | null = null;
  private static activeTarget: HTMLElement | null = null;
  /**
   * Timestamp of the last touch pointer-down (class-wide — the synthetic
   * mouse events after a tap fire on whatever element is under it). Show
   * paths invoked by mouse events within the guard window are ignored.
   */
  private static lastTouchDownAt = 0;

  /**
   * Attach a tooltip to a target element. `content` may be a getter —
   * re-evaluated on every show (state-dependent labels, e.g. open/close).
   * @returns a disposer that detaches all listeners and hides the popup.
   */
  static attach(
    target: HTMLElement,
    content: string | (() => string),
    options: TooltipOptions = {}
  ): () => void {
    const placement = options.placement ?? 'top';
    const align = options.align ?? 'center';

    // Long-press tuning (touch only): hold duration + movement slop.
    const LONG_PRESS_MS = 500;
    const MOVE_SLOP_PX = 8;
    const TOUCH_GUARD_MS = 500;

    // Hide on scroll so the popup never strands mid-air while open. The
    // listeners only exist while visible / a press is pending, so attach()
    // leaks no global handlers.
    const onScroll = () => hide();

    let pressTimer: number | null = null;
    let pressStart: { x: number; y: number } | null = null;
    let touchPress = false;

    const clearPress = (): void => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      pressStart = null;
      touchPress = false;
    };

    /** Renders the popup. No event-origin checks — callers pre-filter. */
    const showNow = (): void => {
      Tooltip.activeTarget = target;
      const popup = Tooltip.ensurePopup();
      popup.textContent = typeof content === 'function' ? content() : content;
      popup.classList.add('nn-tooltip--visible');
      Tooltip.position(target, popup, placement, align);
      window.addEventListener('scroll', onScroll, true);
      // Any pointer-down anywhere (a tap on the element itself included —
      // tabs, laschen and handles move their elements on activation) ends
      // the tooltip: it must never float over a moved target.
      document.addEventListener('pointerdown', onDocPointerDown, true);
    };

    /** Mouse/keyboard entry point: skip the synthetic mouse events that
     * browsers fire after a touch (they would show a tooltip on every
     * tap — touch shows one only via long-press). */
    const show = (): void => {
      if (Date.now() - Tooltip.lastTouchDownAt < TOUCH_GUARD_MS) return;
      showNow();
    };

    const hide = (): void => {
      clearPress();
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      if (Tooltip.activeTarget !== target) return;
      Tooltip.activeTarget = null;
      Tooltip.popup?.classList.remove('nn-tooltip--visible');
    };

    const onDocPointerDown = (): void => hide();

    const onMouseEnter = () => show();
    const onMouseLeave = () => hide();
    // Focus goes through the same guard as mouseenter: tapping a button on
    // touch fires focus on it after the click, and an unguarded showNow()
    // here would plant a tooltip that nothing ever hides (the pointer
    // sequence is already over). Keyboard tabbing still shows the tooltip —
    // its lastTouchDownAt is far in the past.
    const onFocus = () => show();
    const onBlur = () => hide();

    // Touch long-press: hold ~500ms on the element → tooltip; release,
    // movement beyond the slop or scroll cancels/hides it.
    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return;
      Tooltip.lastTouchDownAt = Date.now();
      touchPress = true;
      pressStart = { x: e.clientX, y: e.clientY };
      if (pressTimer !== null) clearTimeout(pressTimer);
      pressTimer = window.setTimeout(() => {
        pressTimer = null;
        showNow();
      }, LONG_PRESS_MS);
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (!touchPress || !pressStart) return;
      if (
        Math.abs(e.clientX - pressStart.x) > MOVE_SLOP_PX ||
        Math.abs(e.clientY - pressStart.y) > MOVE_SLOP_PX
      ) {
        // Drag, not a long-press — abort the pending tooltip.
        clearPress();
      }
    };
    const onPointerUp = (): void => {
      if (!touchPress) return;
      if (pressTimer !== null) {
        clearPress(); // plain tap — timer never fired
      } else {
        hide(); // long-press tooltip ends with the release
      }
    };
    const onPointerCancel = (): void => {
      if (!touchPress) return;
      clearPress();
      hide();
    };

    target.addEventListener('mouseenter', onMouseEnter);
    target.addEventListener('mouseleave', onMouseLeave);
    target.addEventListener('focus', onFocus);
    target.addEventListener('blur', onBlur);
    target.addEventListener('pointerdown', onPointerDown);
    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerCancel);

    return () => {
      target.removeEventListener('mouseenter', onMouseEnter);
      target.removeEventListener('mouseleave', onMouseLeave);
      target.removeEventListener('focus', onFocus);
      target.removeEventListener('blur', onBlur);
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerCancel);
      hide();
    };
  }

  private static ensurePopup(): HTMLElement {
    if (!Tooltip.popup) {
      const el = document.createElement('div');
      el.className = 'nn-tooltip';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
      Tooltip.popup = el;
    }
    return Tooltip.popup;
  }

  private static position(
    target: HTMLElement,
    popup: HTMLElement,
    placement: TooltipPlacement,
    align: TooltipAlign
  ): void {
    const rect = target.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const margin = 8;

    let left: number;
    if (align === 'start') {
      left = rect.left;
    } else if (align === 'end') {
      left = rect.left + rect.width - pw;
    } else {
      left = rect.left + rect.width / 2 - pw / 2;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));

    let top =
      placement === 'top' ? rect.top - ph - margin : rect.bottom + margin;
    // Flip to the opposite side if the preferred edge has no room.
    if (placement === 'top' && top < margin) top = rect.bottom + margin;
    if (placement === 'bottom' && top + ph > window.innerHeight - margin)
      top = rect.top - ph - margin;

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }
}
