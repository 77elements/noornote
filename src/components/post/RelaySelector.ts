/**
 * RelaySelector Component
 * Reusable relay selection dropdown for posting
 *
 * Features:
 * - Multi-select checkbox dropdown
 * - TEST mode support (single relay, disabled)
 * - Clean URL display (removes wss:// prefix)
 */

export interface RelaySelectorConfig {
  availableRelays: string[];
  selectedRelays: Set<string>;
  isTestMode: boolean;
  onChange: (selectedRelays: Set<string>) => void;
}

export class RelaySelector {
  private config: RelaySelectorConfig;
  private container: HTMLElement | null = null;
  private documentClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(config: RelaySelectorConfig) {
    this.config = config;
  }

  /**
   * Render relay selector HTML
   */
  public render(): string {
    const relayOptions = this.config.availableRelays.map(relay => {
      const isSelected = this.config.selectedRelays.has(relay);
      const cleanUrl = relay.replace(/^wss?:\/\//, '');

      return `
        <label class="nn-checkbox">
          <input
            type="checkbox"
            value="${relay}"
            ${isSelected ? 'checked' : ''}
            ${this.config.isTestMode ? 'disabled' : ''}
          />
          <span>${cleanUrl}</span>
        </label>
      `;
    }).join('');

    return `
      <div class="post-note-relay-selector">
        <label class="relay-selector-label">Post to:</label>
        <div class="custom-dropdown custom-dropdown--multi">
          <button class="custom-dropdown__trigger" type="button" ${this.config.isTestMode ? 'disabled' : ''}>
            <span class="custom-dropdown__label">${this.getSelectionText()}</span>
            <span class="custom-dropdown__arrow" aria-hidden="true"></span>
          </button>
          <div class="custom-dropdown__menu">
            ${relayOptions}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Setup event listeners after rendering
   */
  public setupEventListeners(container: HTMLElement): void {
    this.container = container;

    const wrapper = container.querySelector('.custom-dropdown');
    const trigger = container.querySelector('.custom-dropdown__trigger');
    const menu = container.querySelector('.custom-dropdown__menu') as HTMLElement;

    if (!wrapper || !trigger || !menu || this.config.isTestMode) return;

    // Toggle dropdown on trigger click
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      wrapper.classList.toggle('custom-dropdown--open');
    });

    // Handle checkbox changes
    const checkboxes = menu.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const input = e.target as HTMLInputElement;
        if (input.checked) {
          this.config.selectedRelays.add(input.value);
        } else {
          this.config.selectedRelays.delete(input.value);
        }
        this.updateDisplay();
        this.config.onChange(this.config.selectedRelays);
      });
    });

    // Close dropdown when clicking outside
    this.documentClickHandler = (e: MouseEvent) => {
      if (!wrapper.contains(e.target as Node)) {
        wrapper.classList.remove('custom-dropdown--open');
      }
    };
    document.addEventListener('click', this.documentClickHandler);
  }

  /**
   * Update display text
   */
  public updateDisplay(): void {
    if (!this.container) return;

    const label = this.container.querySelector('.custom-dropdown__label');
    if (label) {
      label.textContent = this.getSelectionText();
    }
  }

  /**
   * Get selection display text
   */
  private getSelectionText(): string {
    if (this.config.isTestMode) {
      return 'Local relay (TEST mode)';
    }

    const count = this.config.selectedRelays.size;
    if (count === 0) return 'Select relays...';
    if (count === 1) return '1 relay';
    return `${count} relays`;
  }

  /**
   * Cleanup event listeners
   */
  public destroy(): void {
    if (this.documentClickHandler) {
      document.removeEventListener('click', this.documentClickHandler);
      this.documentClickHandler = null;
    }
    this.container = null;
  }
}
