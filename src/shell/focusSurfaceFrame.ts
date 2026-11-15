/**
 * Focus surface frame (v2) — shared chrome for domain surfaces that swap
 * inner views inside the focus column (articles: list ↔ detail, social:
 * timeline ↔ note). Provides the root element and the list/detail swap;
 * the visible back control lives in the object's action-button stack
 * (focusStage), so the frame only broadcasts the detail state via
 * 'focus:surface-back'.
 */

export interface FocusSurfaceFrame {
  /** Root element to hand out as FocusDomainSurface.element. */
  readonly element: HTMLElement;
  /**
   * Swap the column content to a detail element. Detaches the list AND any
   * previous detail from the DOM — views' destroy() methods do NOT detach
   * their elements, so the frame owns the removal (a leftover detail would
   * push the later list down → phantom gap above the first card).
   */
  swapToDetail(el: HTMLElement): void;
  /**
   * Swap the column content back to the list element. Detaches the current
   * detail element from the DOM (see swapToDetail).
   */
  swapToList(el: HTMLElement): void;
  /** Broadcast detail visibility (drives the object's back action). */
  setBackVisible(visible: boolean): void;
  /** Drop all references (the surface destroys its views itself). */
  destroy(): void;
}

export function createFocusSurfaceFrame(className: string): FocusSurfaceFrame {
  const element = document.createElement('div');
  element.className = `focus-surface ${className}`;

  let listEl: HTMLElement | null = null;
  let detailEl: HTMLElement | null = null;

  return {
    element,
    swapToDetail: el => {
      listEl?.remove();
      detailEl?.remove();
      detailEl = el;
      element.appendChild(el);
    },
    swapToList: el => {
      detailEl?.remove();
      detailEl = null;
      listEl = el;
      element.appendChild(el);
    },
    setBackVisible: visible => {
      // The object's action-button stack mirrors this state (the satellite
      // back button below the close X) — focusStage listens on the object.
      element.dispatchEvent(
        new CustomEvent('focus:surface-back', {
          bubbles: true,
          detail: { visible },
        })
      );
    },
    destroy: () => {
      listEl?.remove();
      detailEl?.remove();
      listEl = null;
      detailEl = null;
    },
  };
}
