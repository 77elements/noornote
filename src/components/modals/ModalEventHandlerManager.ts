/**
 * ModalEventHandlerManager
 * Centralized event listener setup for modals with compose/preview functionality
 *
 * Single Responsibility: Handle tab switching, textarea input, and action buttons
 * Used by: PostNoteModal, ReplyModal
 */

export type TabMode = 'edit' | 'preview' | 'drafts';

export interface ModalEventHandlerConfig {
  /** Modal container selector (e.g., '.post-note-modal') */
  modalSelector: string;
  /** Textarea selector (e.g., '[data-textarea]') */
  textareaSelector: string;
  /** Active tab CSS class (e.g., 'post-note-tab--active') */
  activeTabClass: string;
  /** Current tab mode */
  currentTab: TabMode;
  /** Callback when tab is switched */
  onTabSwitch: (tab: TabMode) => void;
  /** Callback when textarea content changes */
  onTextInput: (value: string) => void;
  /** Callback when cancel button is clicked */
  onCancel: () => void;
  /** Callback when submit button is clicked */
  onSubmit: () => void;
  /** Callback when the "Save draft" button is clicked (optional) */
  onSaveDraft?: () => void;
}

export class ModalEventHandlerManager {
  private config: ModalEventHandlerConfig;
  private modal: HTMLElement | null = null;

  constructor(config: ModalEventHandlerConfig) {
    this.config = config;
  }

  /**
   * Setup all event listeners
   */
  public setupEventListeners(): void {
    this.modal = document.querySelector(this.config.modalSelector);
    if (!this.modal) return;

    this.setupTabSwitching();
    this.setupTextareaInput();
    this.setupActionButtons();
  }

  /**
   * Setup tab switching event listeners
   */
  private setupTabSwitching(): void {
    if (!this.modal) return;

    const tabs = this.modal.querySelectorAll('[data-tab]');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const tabName = target.dataset.tab as TabMode;
        this.switchTab(tabName);
      });
    });
  }

  /**
   * Setup textarea input event listener
   */
  private setupTextareaInput(): void {
    if (!this.modal) return;

    const textarea = this.modal.querySelector(this.config.textareaSelector) as HTMLTextAreaElement;
    if (textarea) {
      textarea.addEventListener('input', () => {
        this.config.onTextInput(textarea.value);
      });
    }
  }

  /**
   * Setup action button event listeners
   */
  private setupActionButtons(): void {
    if (!this.modal) return;

    const cancelBtn = this.modal.querySelector('[data-action="cancel"]');
    const submitBtn = this.modal.querySelector('[data-action="post"]');
    const saveDraftBtn = this.modal.querySelector('[data-action="save-draft"]');

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.config.onCancel());
    }

    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.config.onSubmit());
    }

    if (saveDraftBtn && this.config.onSaveDraft) {
      saveDraftBtn.addEventListener('click', () => this.config.onSaveDraft!());
    }
  }

  /**
   * Switch between Edit/Preview tabs
   */
  private switchTab(tab: TabMode): void {
    this.config.currentTab = tab;

    // Save content when leaving the edit tab (preview or drafts) so the text
    // is preserved when switching back.
    if (tab !== 'edit') {
      const textarea = document.querySelector(this.config.textareaSelector) as HTMLTextAreaElement;
      if (textarea) {
        this.config.onTextInput(textarea.value);
      }
    }

    // Update tab button states
    this.updateTabButtons(tab);

    // Notify parent component
    this.config.onTabSwitch(tab);
  }

  /**
   * Update tab button active states
   */
  private updateTabButtons(activeTab: TabMode): void {
    const tabs = document.querySelectorAll('[data-tab]');
    tabs.forEach(tabEl => {
      const tabElement = tabEl as HTMLElement;
      if (tabElement.dataset.tab === activeTab) {
        tabElement.classList.add(this.config.activeTabClass);
      } else {
        tabElement.classList.remove(this.config.activeTabClass);
      }
    });
  }

  /**
   * Re-setup textarea listener after DOM updates (e.g., tab switch)
   */
  public refreshTextareaListener(): void {
    if (!this.modal) return;

    const textarea = this.modal.querySelector(this.config.textareaSelector) as HTMLTextAreaElement;
    if (textarea) {
      // Remove old listener by cloning (simple approach)
      const newTextarea = textarea.cloneNode(true) as HTMLTextAreaElement;
      textarea.parentNode?.replaceChild(newTextarea, textarea);

      // Add new listener
      newTextarea.addEventListener('input', () => {
        this.config.onTextInput(newTextarea.value);
      });
    }
  }

  /**
   * Cleanup event listeners
   */
  public destroy(): void {
    this.modal = null;
  }

  /**
   * Restore modal state after a failed post/reply attempt
   */
  public static restoreAfterError(
    modalContainer: HTMLElement | null,
    originalDisplay: string,
    buttonText: string
  ): void {
    if (modalContainer) {
      modalContainer.style.display = originalDisplay;
    }
    const postBtn = document.querySelector('[data-action="post"]') as HTMLButtonElement;
    if (postBtn) {
      postBtn.disabled = false;
      postBtn.textContent = buttonText;
    }
  }
}
