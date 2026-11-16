/**
 * Focus surface frame (v2) — shared chrome for domain surfaces that swap
 * inner views inside the focus column (articles: list ↔ detail, social:
 * timeline ↔ note). The frame owns NO element of its own: it attaches to
 * the stage's column slot (.focus-object__content) and guarantees exactly
 * one content element in it. The visible back control lives in the
 * object's action-button stack (focusStage), so the frame only broadcasts
 * the detail state via 'focus:surface-back' (dispatched on the slot — it
 * bubbles up to the object element, where focusStage listens).
 */

export interface FocusSurfaceFrame {
  /** Take ownership of the stage's column slot. */
  attach(slot: HTMLElement): void;
  /** Drop the slot reference (the stage clears the slot itself). */
  detach(): void;
  /** The attached slot (the column's scroll container). */
  readonly slot: HTMLElement | null;
  /**
   * Swap the column content to a detail element. Replaces list AND any
   * previous detail — views' destroy() methods do NOT detach their
   * elements, so the frame owns the removal (a leftover detail would
   * push the later list down → phantom gap above the first card).
   */
  swapToDetail(el: HTMLElement): void;
  /**
   * Swap the column content back to the list element (same ownership as
   * swapToDetail).
   */
  swapToList(el: HTMLElement): void;
  /** Broadcast detail visibility (drives the object's back action). */
  setBackVisible(visible: boolean): void;
  /** Drop all references (the surface destroys its views itself). */
  destroy(): void;
}

export function createFocusSurfaceFrame(): FocusSurfaceFrame {
  let slot: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let detailEl: HTMLElement | null = null;

  return {
    attach: s => {
      slot = s;
      // The list may have resolved before the stage attached the surface
      // (createSurface is awaited) — mount the current content now.
      const current = detailEl ?? listEl;
      if (current) slot.replaceChildren(current);
    },
    detach: () => {
      // Old semantics: the surface's content leaves the DOM (the views
      // stay cached on the surface).
      slot?.replaceChildren();
      slot = null;
    },
    get slot() {
      return slot;
    },
    swapToDetail: el => {
      detailEl = el;
      if (slot) slot.replaceChildren(el);
    },
    swapToList: el => {
      detailEl = null;
      listEl = el;
      if (slot) slot.replaceChildren(el);
    },
    setBackVisible: visible => {
      // The object's action-button stack mirrors this state (the satellite
      // back button below the close X) — focusStage listens on the object.
      slot?.dispatchEvent(
        new CustomEvent('focus:surface-back', {
          bubbles: true,
          detail: { visible },
        })
      );
    },
    destroy: () => {
      listEl = null;
      detailEl = null;
      slot = null;
    },
  };
}
