/**
 * addSwipeSupport - attach horizontal swipe detection to an element.
 *
 * Fires onSwipeLeft / onSwipeRight when a touch gesture is predominantly
 * horizontal and travels past a small threshold, so vertical scrolls and taps
 * are ignored. Listeners are passive and live on `container`; they are released
 * automatically when the element is removed from the DOM.
 */
export function addSwipeSupport(
  container: HTMLElement,
  onSwipeLeft: () => void,
  onSwipeRight: () => void
): void {
  let startX = 0;
  let startY = 0;

  container.addEventListener('touchstart', (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });

  container.addEventListener('touchend', (e: TouchEvent) => {
    const touch = e.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    // Only trigger if horizontal swipe is dominant and exceeds threshold
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX < 0) onSwipeLeft();
      else onSwipeRight();
    }
  }, { passive: true });
}
