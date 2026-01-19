/**
 * NotificationPrioritySection Component
 * Manages notification priority settings with drag & drop
 *
 * @purpose Configure which notification types trigger which badge style
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { PerAccountLocalStorage, StorageKeys, type NotificationPriority, type NotificationPriorityMap } from '../../services/PerAccountLocalStorage';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';

interface NotificationTypeInfo {
  type: string;
  label: string;
}

const NOTIFICATION_TYPES: NotificationTypeInfo[] = [
  { type: 'reply', label: 'Replies' },
  { type: 'thread-reply', label: 'Thread Replies' },
  { type: 'quote', label: 'Quotes' },
  { type: 'zap', label: 'Zaps' },
  { type: 'mention', label: 'Mentions' },
  { type: 'repost', label: 'Reposts' },
  { type: 'reaction', label: 'Reactions' },
  { type: 'article', label: 'Articles' },
  { type: 'mutual_new', label: 'New Mutuals' },
  { type: 'mutual_unfollow', label: 'Mutual Unfollows' },
  { type: 'hashtag', label: 'Hashtags' },
];

const DEFAULT_PRIORITIES: NotificationPriorityMap = {
  'reply': 1,
  'quote': 1,
  'zap': 1,
  'mention': 2,
  'repost': 2,
  'reaction': 2,
  'article': 2,
  'mutual_new': 2,
  'mutual_unfollow': 2,
  'thread-reply': 3,
  'hashtag': 3,
};

const PRIORITY_LABELS: Record<NotificationPriority, { title: string; description: string }> = {
  1: { title: 'High Priority', description: 'Pulsing badge - important notifications' },
  2: { title: 'Normal Priority', description: 'Solid badge - regular notifications' },
  3: { title: 'Low Priority', description: 'Hollow badge - background notifications' },
};

export class NotificationPrioritySection extends SettingsSection {
  private storage: PerAccountLocalStorage;
  private eventBus: EventBus;
  private priorities: NotificationPriorityMap;
  private contentContainer: HTMLElement | null = null;
  private hasUnsavedChanges = false;

  // Mouse drag state
  private draggedItem: HTMLElement | null = null;
  private draggedType: string | null = null;
  private isDragging = false;
  private startX = 0;
  private startY = 0;
  private offsetX = 0;
  private offsetY = 0;

  // Bound handlers for cleanup
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: ((e: MouseEvent) => void) | null = null;
  private boundTouchMove: ((e: TouchEvent) => void) | null = null;
  private boundTouchEnd: ((e: TouchEvent) => void) | null = null;

  constructor() {
    super('notification-priority');
    this.storage = PerAccountLocalStorage.getInstance();
    this.eventBus = EventBus.getInstance();
    this.priorities = this.loadPriorities();
  }

  /**
   * Load priorities from storage or use defaults
   */
  private loadPriorities(): NotificationPriorityMap {
    return this.storage.get<NotificationPriorityMap>(StorageKeys.NOTIFICATION_PRIORITIES, { ...DEFAULT_PRIORITIES });
  }

  /**
   * Save priorities to storage
   */
  private savePriorities(): void {
    this.storage.set(StorageKeys.NOTIFICATION_PRIORITIES, this.priorities);
    this.eventBus.emit('notifications:priorities-changed');
  }

  /**
   * Mount section content into the DOM
   */
  public mount(parentContainer: HTMLElement): void {
    this.contentContainer = this.getContentContainer(parentContainer);
    if (!this.contentContainer) return;

    this.contentContainer.innerHTML = this.renderContent();
    this.bindListeners();
  }

  /**
   * Render the priority configuration UI
   */
  private renderContent(): string {
    return `
      <div class="notification-priority-settings">
        <div class="form__info">
          <p>Drag notification types between priority levels to customize your badge indicator.</p>
        </div>

        ${this.renderPriorityZone(1)}
        ${this.renderPriorityZone(2)}
        ${this.renderPriorityZone(3)}

        <div class="notification-priority-actions">
          <button class="btn btn--mini btn--passive" data-action="reset-priorities">
            Reset to Defaults
          </button>
          <button class="btn btn--mini btn--primary" data-action="save-priorities" ${this.hasUnsavedChanges ? '' : 'disabled'}>
            Save
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Render a priority drop zone
   */
  private renderPriorityZone(priority: NotificationPriority): string {
    const { title, description } = PRIORITY_LABELS[priority];
    const items = this.getItemsForPriority(priority);

    return `
      <div class="priority-zone" data-priority="${priority}">
        <div class="priority-zone__header">
          <span class="priority-zone__badge priority-zone__badge--${priority}"></span>
          <div class="priority-zone__info">
            <h4 class="priority-zone__title">${title}</h4>
            <p class="priority-zone__description">${description}</p>
          </div>
        </div>
        <div class="priority-zone__items" data-priority="${priority}">
          ${items.map(item => this.renderDraggableItem(item)).join('')}
        </div>
      </div>
    `;
  }

  /**
   * Get notification types for a priority level
   */
  private getItemsForPriority(priority: NotificationPriority): NotificationTypeInfo[] {
    return NOTIFICATION_TYPES.filter(item => this.priorities[item.type] === priority);
  }

  /**
   * Render a draggable notification type item
   */
  private renderDraggableItem(item: NotificationTypeInfo): string {
    return `
      <div class="priority-item" data-type="${item.type}">
        <span class="priority-item__handle">⋮⋮</span>
        <span class="priority-item__label">${item.label}</span>
      </div>
    `;
  }

  /**
   * Bind drag & drop and other event listeners
   */
  private bindListeners(): void {
    if (!this.contentContainer) return;

    // Reset button
    const resetBtn = this.contentContainer.querySelector('[data-action="reset-priorities"]');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.resetToDefaults());
    }

    // Save button
    const saveBtn = this.contentContainer.querySelector('[data-action="save-priorities"]');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.saveChanges());
    }

    // Mouse-based drag & drop (like bookmarks.ts pattern)
    this.setupMouseDragAndDrop();

    // Touch support for mobile
    this.setupTouchDragAndDrop();
  }

  /**
   * Setup mouse-based drag & drop (not HTML5 draggable)
   */
  private setupMouseDragAndDrop(): void {
    if (!this.contentContainer) return;

    const settingsContainer = this.contentContainer.querySelector('.notification-priority-settings');
    if (!settingsContainer) return;

    settingsContainer.addEventListener('mousedown', (e: Event) => this.onMouseDown(e as MouseEvent));
  }

  private onMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const item = target.closest('.priority-item') as HTMLElement;
    if (!item) return;

    e.preventDefault();
    this.draggedItem = item;
    this.draggedType = item.dataset.type || null;
    this.startX = e.clientX;
    this.startY = e.clientY;

    const rect = item.getBoundingClientRect();
    this.offsetX = e.clientX - rect.left;
    this.offsetY = e.clientY - rect.top;

    this.boundMouseMove = (ev: MouseEvent) => this.onMouseMove(ev);
    this.boundMouseUp = (ev: MouseEvent) => this.onMouseUp(ev);

    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.draggedItem) return;

    const dx = Math.abs(e.clientX - this.startX);
    const dy = Math.abs(e.clientY - this.startY);

    // Start dragging after threshold
    if (!this.isDragging && (dx > 5 || dy > 5)) {
      this.isDragging = true;
      this.draggedItem.classList.add('priority-item--dragging');
      this.draggedItem.style.position = 'fixed';
      this.draggedItem.style.zIndex = '1000';
      this.draggedItem.style.width = this.draggedItem.offsetWidth + 'px';
      this.draggedItem.style.pointerEvents = 'none';
    }

    if (this.isDragging) {
      this.draggedItem.style.left = (e.clientX - this.offsetX) + 'px';
      this.draggedItem.style.top = (e.clientY - this.offsetY) + 'px';

      // Highlight drop zone under cursor
      const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
      const zoneBelow = elemBelow?.closest('.priority-zone__items') as HTMLElement;

      this.contentContainer?.querySelectorAll('.priority-zone__items').forEach(z => {
        z.classList.remove('priority-zone__items--drag-over');
      });

      if (zoneBelow) {
        zoneBelow.classList.add('priority-zone__items--drag-over');
      }
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.boundMouseMove) {
      document.removeEventListener('mousemove', this.boundMouseMove);
    }
    if (this.boundMouseUp) {
      document.removeEventListener('mouseup', this.boundMouseUp);
    }

    if (!this.draggedItem || !this.isDragging) {
      this.resetDragState();
      return;
    }

    // Find drop zone under cursor
    const savedDisplay = this.draggedItem.style.display;
    this.draggedItem.style.display = 'none';
    const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
    this.draggedItem.style.display = savedDisplay;

    const dropZone = elemBelow?.closest('.priority-zone__items') as HTMLElement;

    // Clear drag-over states
    this.contentContainer?.querySelectorAll('.priority-zone__items').forEach(z => {
      z.classList.remove('priority-zone__items--drag-over');
    });

    if (dropZone && this.draggedType) {
      const newPriority = parseInt(dropZone.dataset.priority || '2', 10) as NotificationPriority;

      if (this.priorities[this.draggedType] !== newPriority) {
        this.priorities[this.draggedType] = newPriority;
        this.markAsUnsaved();
        this.rerender();
        return; // rerender will reset state
      }
    }

    // Reset item style if no change
    this.draggedItem.classList.remove('priority-item--dragging');
    this.draggedItem.style.position = '';
    this.draggedItem.style.zIndex = '';
    this.draggedItem.style.width = '';
    this.draggedItem.style.left = '';
    this.draggedItem.style.top = '';
    this.draggedItem.style.pointerEvents = '';

    this.resetDragState();
  }

  /**
   * Setup touch-based drag & drop for mobile
   */
  private setupTouchDragAndDrop(): void {
    if (!this.contentContainer) return;

    const settingsContainer = this.contentContainer.querySelector('.notification-priority-settings');
    if (!settingsContainer) return;

    settingsContainer.addEventListener('touchstart', (e: Event) => this.onTouchStart(e as TouchEvent), { passive: false });
  }

  private onTouchStart(e: TouchEvent): void {
    const target = e.target as HTMLElement;
    const item = target.closest('.priority-item') as HTMLElement;
    if (!item) return;

    const touch = e.touches[0];
    if (!touch) return;

    e.preventDefault();
    this.draggedItem = item;
    this.draggedType = item.dataset.type || null;
    this.startX = touch.clientX;
    this.startY = touch.clientY;

    const rect = item.getBoundingClientRect();
    this.offsetX = touch.clientX - rect.left;
    this.offsetY = touch.clientY - rect.top;

    this.boundTouchMove = (ev: TouchEvent) => this.onTouchMove(ev);
    this.boundTouchEnd = (ev: TouchEvent) => this.onTouchEnd(ev);

    document.addEventListener('touchmove', this.boundTouchMove, { passive: false });
    document.addEventListener('touchend', this.boundTouchEnd);
  }

  private onTouchMove(e: TouchEvent): void {
    if (!this.draggedItem) return;

    const touch = e.touches[0];
    if (!touch) return;

    e.preventDefault();

    const dx = Math.abs(touch.clientX - this.startX);
    const dy = Math.abs(touch.clientY - this.startY);

    // Start dragging after threshold
    if (!this.isDragging && (dx > 5 || dy > 5)) {
      this.isDragging = true;
      this.draggedItem.classList.add('priority-item--dragging');
      this.draggedItem.style.position = 'fixed';
      this.draggedItem.style.zIndex = '1000';
      this.draggedItem.style.width = this.draggedItem.offsetWidth + 'px';
      this.draggedItem.style.pointerEvents = 'none';
    }

    if (this.isDragging) {
      this.draggedItem.style.left = (touch.clientX - this.offsetX) + 'px';
      this.draggedItem.style.top = (touch.clientY - this.offsetY) + 'px';

      // Highlight drop zone under finger
      const elemBelow = document.elementFromPoint(touch.clientX, touch.clientY);
      const zoneBelow = elemBelow?.closest('.priority-zone__items') as HTMLElement;

      this.contentContainer?.querySelectorAll('.priority-zone__items').forEach(z => {
        z.classList.remove('priority-zone__items--drag-over');
      });

      if (zoneBelow) {
        zoneBelow.classList.add('priority-zone__items--drag-over');
      }
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    if (this.boundTouchMove) {
      document.removeEventListener('touchmove', this.boundTouchMove);
    }
    if (this.boundTouchEnd) {
      document.removeEventListener('touchend', this.boundTouchEnd);
    }

    if (!this.draggedItem || !this.isDragging) {
      this.resetDragState();
      return;
    }

    const touch = e.changedTouches[0];
    if (!touch) {
      this.resetDragState();
      return;
    }

    // Find drop zone under finger
    const savedDisplay = this.draggedItem.style.display;
    this.draggedItem.style.display = 'none';
    const elemBelow = document.elementFromPoint(touch.clientX, touch.clientY);
    this.draggedItem.style.display = savedDisplay;

    const dropZone = elemBelow?.closest('.priority-zone__items') as HTMLElement;

    // Clear drag-over states
    this.contentContainer?.querySelectorAll('.priority-zone__items').forEach(z => {
      z.classList.remove('priority-zone__items--drag-over');
    });

    if (dropZone && this.draggedType) {
      const newPriority = parseInt(dropZone.dataset.priority || '2', 10) as NotificationPriority;

      if (this.priorities[this.draggedType] !== newPriority) {
        this.priorities[this.draggedType] = newPriority;
        this.markAsUnsaved();
        this.rerender();
        return; // rerender will reset state
      }
    }

    // Reset item style if no change
    this.draggedItem.classList.remove('priority-item--dragging');
    this.draggedItem.style.position = '';
    this.draggedItem.style.zIndex = '';
    this.draggedItem.style.width = '';
    this.draggedItem.style.left = '';
    this.draggedItem.style.top = '';
    this.draggedItem.style.pointerEvents = '';

    this.resetDragState();
  }

  private resetDragState(): void {
    this.draggedItem = null;
    this.draggedType = null;
    this.isDragging = false;
  }

  /**
   * Mark configuration as having unsaved changes
   */
  private markAsUnsaved(): void {
    this.hasUnsavedChanges = true;
  }

  /**
   * Save changes to storage
   */
  private saveChanges(): void {
    this.savePriorities();
    this.hasUnsavedChanges = false;
    this.rerender();
    ToastService.show('Notification priorities saved', 'success');
  }

  /**
   * Reset to default priorities
   */
  private resetToDefaults(): void {
    this.priorities = { ...DEFAULT_PRIORITIES };
    this.markAsUnsaved();
    this.rerender();
  }

  /**
   * Re-render the content
   */
  private rerender(): void {
    if (!this.contentContainer) return;
    this.contentContainer.innerHTML = this.renderContent();
    this.bindListeners();
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    // Cleanup document-level listeners
    if (this.boundMouseMove) {
      document.removeEventListener('mousemove', this.boundMouseMove);
    }
    if (this.boundMouseUp) {
      document.removeEventListener('mouseup', this.boundMouseUp);
    }
    if (this.boundTouchMove) {
      document.removeEventListener('touchmove', this.boundTouchMove);
    }
    if (this.boundTouchEnd) {
      document.removeEventListener('touchend', this.boundTouchEnd);
    }

    this.contentContainer = null;
    this.resetDragState();
  }
}

/**
 * Get notification priorities (exported for use by NotificationsOrchestrator)
 */
export function getNotificationPriorities(): NotificationPriorityMap {
  const storage = PerAccountLocalStorage.getInstance();
  return storage.get<NotificationPriorityMap>(StorageKeys.NOTIFICATION_PRIORITIES, { ...DEFAULT_PRIORITIES });
}

export { DEFAULT_PRIORITIES };
