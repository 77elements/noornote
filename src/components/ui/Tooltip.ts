/**
 * Tooltip Component (nn-tooltip)
 *
 * Lightweight, reusable hover popup. Appears instantly when the pointer enters
 * a target element and disappears the moment it leaves (also on focus/blur for
 * keyboard users). A single shared popup node is portalled to <body> so it is
 * never clipped by an overflow:hidden ancestor and never inherits stacking
 * context from the target.
 *
 * Central UI primitive in the spirit of Modal / CustomDropdown: own .ts + .scss,
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
   * Attach a tooltip to a target element.
   * @returns a disposer that detaches all listeners and hides the popup.
   */
  static attach(
    target: HTMLElement,
    content: string,
    options: TooltipOptions = {}
  ): () => void {
    const placement = options.placement ?? 'top';
    const align = options.align ?? 'center';

    // Hide on scroll so the popup never strands mid-air while open. The scroll
    // listener only exists while visible, so attach() leaks no global handler.
    const onScroll = () => hide();

    const show = (): void => {
      Tooltip.activeTarget = target;
      const popup = Tooltip.ensurePopup();
      popup.textContent = content;
      popup.classList.add('nn-tooltip--visible');
      Tooltip.position(target, popup, placement, align);
      window.addEventListener('scroll', onScroll, true);
    };

    const hide = (): void => {
      window.removeEventListener('scroll', onScroll, true);
      if (Tooltip.activeTarget !== target) return;
      Tooltip.activeTarget = null;
      Tooltip.popup?.classList.remove('nn-tooltip--visible');
    };

    target.addEventListener('mouseenter', show);
    target.addEventListener('mouseleave', hide);
    target.addEventListener('focus', show);
    target.addEventListener('blur', hide);

    return () => {
      target.removeEventListener('mouseenter', show);
      target.removeEventListener('mouseleave', hide);
      target.removeEventListener('focus', show);
      target.removeEventListener('blur', hide);
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
