/**
 * AddonNavReorder - lets the user reorder the sidebar addon list.
 *
 *  - Desktop: mouse drag a row up/down (small threshold so a plain click still navigates).
 *  - Touch: long-press the list to enter "reorder mode" (reveals ▲▼ per row); tap ▲▼ to move,
 *    tap outside the list to leave the mode.
 *
 * The order is persisted per account via saveAddonOrder(). Navigation is suppressed while
 * reordering / right after a drag so a reorder never opens an addon by accident.
 * `onOrderChanged` fires after every persist (label/UI refresh hook).
 */

import { saveAddonOrder } from '../../addons/addonOrder';

const REORDER_CLASS = 'primary-nav__submenu--reorder';
const LONG_PRESS_MS = 500;
const DRAG_THRESHOLD = 6;
const TOUCH_MOVE_CANCEL = 10;

export function wireAddonReorder(
  submenu: HTMLElement,
  onOrderChanged?: () => void
): void {
  const rows = () =>
    Array.from(
      submenu.querySelectorAll<HTMLElement>(':scope > li[data-addon-id]')
    );
  const persist = () => {
    saveAddonOrder(
      rows()
        .map(li => li.dataset.addonId || '')
        .filter(Boolean)
    );
    onOrderChanged?.();
  };

  // Capture-phase guard: swallow sublink navigation while reordering or just after a drag.
  let suppressClick = false;
  submenu.addEventListener(
    'click',
    e => {
      if (!suppressClick && !submenu.classList.contains(REORDER_CLASS)) return;
      if ((e.target as HTMLElement).closest('.addon-reorder__btn')) return; // ▲▼ handled below
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  // ▲▼ move buttons (active when visible, i.e. in reorder mode).
  submenu.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest(
      '.addon-reorder__btn'
    ) as HTMLElement | null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const li = btn.closest('li[data-addon-id]') as HTMLElement | null;
    if (!li) return;
    if (btn.dataset.reorder === 'up' && li.previousElementSibling) {
      submenu.insertBefore(li, li.previousElementSibling);
    } else if (btn.dataset.reorder === 'down' && li.nextElementSibling) {
      submenu.insertBefore(li.nextElementSibling, li);
    }
    persist();
  });

  // Desktop mouse drag reorder.
  let dragLi: HTMLElement | null = null;
  let startY = 0;
  let dragging = false;

  const onMouseMove = (e: MouseEvent) => {
    if (!dragLi) return;
    if (!dragging) {
      if (Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      dragLi.classList.add('primary-nav__item--dragging');
    }
    const over = (
      document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    )?.closest('li[data-addon-id]') as HTMLElement | null;
    if (over && over !== dragLi && over.parentElement === submenu) {
      const rect = over.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      submenu.insertBefore(dragLi, after ? over.nextElementSibling : over);
    }
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (dragging) {
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 0);
      persist();
    }
    dragLi?.classList.remove('primary-nav__item--dragging');
    dragLi = null;
    dragging = false;
  };

  // The rows are <a> links — the browser's native link drag would otherwise hijack the gesture
  // (mouseup never fires, the row sticks to the cursor until the next click). Kill it.
  submenu.addEventListener('dragstart', e => e.preventDefault());

  submenu.addEventListener('mousedown', e => {
    if (submenu.classList.contains(REORDER_CLASS)) return; // touch mode uses ▲▼
    if ((e.target as HTMLElement).closest('.addon-reorder__btn')) return;
    const li = (e.target as HTMLElement).closest(
      'li[data-addon-id]'
    ) as HTMLElement | null;
    if (!li) return;
    e.preventDefault(); // no native drag / text selection; click still fires if we don't move
    dragLi = li;
    startY = e.clientY;
    dragging = false;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // Touch long-press → enter reorder mode.
  let pressTimer: number | null = null;
  let pressX = 0;
  let pressY = 0;
  const clearPress = () => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  submenu.addEventListener(
    'touchstart',
    e => {
      if ((e.target as HTMLElement).closest('.addon-reorder__btn')) return;
      const t = e.touches[0];
      if (!t) return;
      pressX = t.clientX;
      pressY = t.clientY;
      clearPress();
      pressTimer = window.setTimeout(() => {
        submenu.classList.add(REORDER_CLASS);
        pressTimer = null;
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );

  submenu.addEventListener(
    'touchmove',
    e => {
      const t = e.touches[0];
      if (
        t &&
        (Math.abs(t.clientX - pressX) > TOUCH_MOVE_CANCEL ||
          Math.abs(t.clientY - pressY) > TOUCH_MOVE_CANCEL)
      )
        clearPress();
    },
    { passive: true }
  );
  submenu.addEventListener('touchend', clearPress, { passive: true });
  submenu.addEventListener('touchcancel', clearPress, { passive: true });

  // Leave reorder mode on any tap outside the submenu.
  document.addEventListener('click', e => {
    if (!submenu.classList.contains(REORDER_CLASS)) return;
    if (!(e.target as HTMLElement).closest('.primary-nav__submenu'))
      submenu.classList.remove(REORDER_CLASS);
  });
}
