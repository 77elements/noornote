/**
 * Shared grid drag-drop mechanics — bookmarks, tribes, NosPress nav menus.
 *
 * Extracts the identical mousedown/mousemove/mouseup + threshold + placeholder
 * + fixed-positioning logic. Caller-specific drop handling stays in onDrop.
 *
 * Mouse-only by design (touch is handled by MoveDropdown / arrow buttons in
 * the consuming UIs).
 */

export interface GridDragDropConfig {
  /** CSS selector for draggable cards, e.g. '.bookmark-card, .folder-card' */
  itemSelector: string;
  /** CSS selector for elements that should NOT start a drag, e.g. '.bookmark-card__delete' */
  excludeSelector: string;
  /** CSS class for the placeholder element, e.g. 'bookmark-card-placeholder' */
  placeholderClass: string;
  /** Extract the item's ID from its HTMLElement (data attributes) */
  getItemId: (el: HTMLElement) => string | null;
  /** Called when a dragged item is dropped onto a target */
  onDrop: (draggedId: string, draggedEl: HTMLElement, dropTarget: HTMLElement) => void;
}

export function setupGridDragDrop(grid: HTMLElement, config: GridDragDropConfig): void {
  let draggedCard: HTMLElement | null = null;
  let draggedId: string | null = null;
  let placeholder: HTMLElement | null = null;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let offsetX = 0;
  let offsetY = 0;

  // Build the :not(.dragging) selector for finding cards below cursor
  const itemParts = config.itemSelector.split(',').map(s => s.trim() + ':not(.dragging)');
  const belowSelector = [...itemParts, '[data-up-nav]'].join(', ');

  const onMouseDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(config.excludeSelector)) return;

    const card = target.closest(config.itemSelector) as HTMLElement;
    if (!card || card.dataset.upNav !== undefined) return;

    e.preventDefault();
    draggedCard = card;
    draggedId = config.getItemId(card);
    startX = e.clientX;
    startY = e.clientY;

    const rect = card.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!draggedCard) return;

    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);

    if (!isDragging && (dx > 5 || dy > 5)) {
      isDragging = true;
      draggedCard.dataset.wasDragging = 'true';
      draggedCard.classList.add('dragging');

      placeholder = document.createElement('div');
      placeholder.className = config.placeholderClass;
      placeholder.style.width = draggedCard.offsetWidth + 'px';
      placeholder.style.height = draggedCard.offsetHeight + 'px';
      draggedCard.parentNode?.insertBefore(placeholder, draggedCard);

      draggedCard.style.position = 'fixed';
      draggedCard.style.zIndex = '1000';
      draggedCard.style.width = draggedCard.offsetWidth + 'px';
      draggedCard.style.pointerEvents = 'none';
    }

    if (isDragging) {
      draggedCard.style.left = (e.clientX - offsetX) + 'px';
      draggedCard.style.top = (e.clientY - offsetY) + 'px';

      const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
      const cardBelow = elemBelow?.closest(belowSelector) as HTMLElement;

      grid.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));

      if (cardBelow && cardBelow !== placeholder) {
        cardBelow.classList.add('drag-over');
      }
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (!draggedCard || !isDragging) {
      draggedCard = null;
      isDragging = false;
      return;
    }

    const savedDisplay = draggedCard.style.display;
    draggedCard.style.display = 'none';
    const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
    draggedCard.style.display = savedDisplay;
    const dropTarget = elemBelow?.closest(config.itemSelector + ', [data-up-nav]') as HTMLElement;

    draggedCard.classList.remove('dragging');
    draggedCard.style.position = '';
    draggedCard.style.zIndex = '';
    draggedCard.style.width = '';
    draggedCard.style.left = '';
    draggedCard.style.top = '';
    draggedCard.style.pointerEvents = '';

    grid.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));

    placeholder?.remove();
    placeholder = null;

    if (dropTarget && draggedId && draggedCard) {
      config.onDrop(draggedId, draggedCard, dropTarget);
    }

    draggedCard = null;
    draggedId = null;
    isDragging = false;
  };

  grid.addEventListener('mousedown', onMouseDown);
}
