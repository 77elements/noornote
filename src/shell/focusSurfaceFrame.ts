/**
 * Focus surface frame (v2) — shared chrome for domain surfaces that swap
 * inner views inside the focus column (articles: list ↔ detail, social:
 * timeline ↔ note). Provides the root element and the back control; the
 * back button sits in the top band (clears the ED-t drawer) and is shown
 * by the surface whenever a detail view replaces the list.
 */

import { _ } from '../i18n';

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
  /** Show/hide the back control. */
  setBackVisible(visible: boolean): void;
  /** Drop all references (the surface destroys its views itself). */
  destroy(): void;
}

export function createFocusSurfaceFrame(
  className: string,
  onBack: () => void
): FocusSurfaceFrame {
  const element = document.createElement('div');
  element.className = `focus-surface ${className}`;

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'focus-surface__back';
  backBtn.setAttribute('aria-label', _('Back'));
  backBtn.innerHTML = '<svg><use href="#icon-back"/></svg>';
  backBtn.addEventListener('click', onBack);
  backBtn.hidden = true;
  element.appendChild(backBtn);

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
      backBtn.hidden = !visible;
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
      backBtn.remove();
      listEl?.remove();
      detailEl?.remove();
      listEl = null;
      detailEl = null;
    },
  };
}
