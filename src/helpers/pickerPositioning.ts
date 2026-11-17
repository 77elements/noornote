/**
 * Shared overlay-picker positioning (EmojiPicker ↔ GifPicker —
 * identical viewport-flip logic).
 */

/** Dimensions of a picker overlay (from CSS) used for viewport-flip math. */
export interface PickerDimensions {
  pickerHeight: number;
  pickerWidth: number;
  /** Gap between the picker edge and the trigger (default 10). */
  margin?: number;
}

/**
 * Position an anchored picker overlay relative to a trigger element:
 * above the trigger when there is room (or more room than below),
 * otherwise below; horizontally the left edge sits over the trigger and
 * flips to open leftward when there isn't room to the right. Collision-
 * based, so it needs no layout-mode knowledge.
 */
export function positionPickerNearTrigger(
  container: HTMLElement,
  trigger: HTMLElement,
  dims: PickerDimensions
): void {
  const rect = trigger.getBoundingClientRect();
  const margin = dims.margin ?? 10;

  // Try to position above trigger, if not enough space, position below
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;

  if (spaceAbove >= dims.pickerHeight || spaceAbove > spaceBelow) {
    // Position above
    container.style.bottom = `${window.innerHeight - rect.top + 10}px`;
    container.style.top = 'auto';
  } else {
    // Position below
    container.style.top = `${rect.bottom + 10}px`;
    container.style.bottom = 'auto';
  }

  // Horizontal: open to the right (left edge over the trigger) by default, but
  // flip to open leftward (right edge over the trigger) when there isn't room —
  // e.g. when the note sits in the right-hand secondary pane. Collision-based,
  // so it needs no layout-mode knowledge.
  if (rect.left + dims.pickerWidth > window.innerWidth - margin) {
    container.style.right = `${window.innerWidth - rect.right}px`;
    container.style.left = 'auto';
  } else {
    container.style.left = `${rect.left}px`;
    container.style.right = 'auto';
  }
}
