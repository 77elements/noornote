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

  return {
    element,
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
    },
  };
}
