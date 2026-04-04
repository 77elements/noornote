/**
 * CustomDropdown Component
 * Minimal JS + CSS-based dropdown with custom styling
 * Fully parametrized and reusable across multiple components
 *
 * @example
 * ```typescript
 * const dropdown = new CustomDropdown({
 *   options: [
 *     { value: 'option1', label: 'Option 1' },
 *     { value: 'option2', label: 'Option 2' }
 *   ],
 *   selectedValue: 'option1',
 *   onChange: (value) => console.log('Selected:', value),
 *   className: 'my-custom-class',
 *   width: '200px',
 *   dataAttributes: { 'note-id': 'abc123', 'user-id': 'xyz789' }
 * });
 *
 * // Mount to DOM
 * document.body.appendChild(dropdown.getElement());
 * ```
 */

export interface DropdownOption {
  value: string;
  label: string;
}

export interface CustomDropdownOptions {
  /** Dropdown options */
  options: DropdownOption[];
  /** Currently selected value */
  selectedValue: string;
  /** Callback when selection changes */
  onChange: (value: string) => void;
  /** Optional CSS class name(s) to add to container */
  className?: string;
  /** Optional custom width (e.g., "200px", "100%", "auto") */
  width?: string;
  /** Optional data-* attributes as key-value pairs (e.g., { "note-id": "abc123" }) */
  dataAttributes?: Record<string, string>;
}

export class CustomDropdown {
  private element: HTMLElement;
  private options: DropdownOption[];
  private selectedValue: string;
  private onChange: (value: string) => void;
  private isOpen = false;

  constructor(config: CustomDropdownOptions) {
    this.options = config.options;
    this.selectedValue = config.selectedValue;
    this.onChange = config.onChange;
    this.element = this.createElement(config);
    this.setupEventListeners();
  }

  /**
   * Create dropdown structure
   */
  private createElement(config: CustomDropdownOptions): HTMLElement {
    const container = document.createElement('div');
    container.className = `custom-dropdown ${config.className || ''}`.trim();

    // Apply custom width if provided
    if (config.width) {
      container.style.width = config.width;
    }

    // Apply data-* attributes if provided
    if (config.dataAttributes) {
      Object.entries(config.dataAttributes).forEach(([key, value]) => {
        container.dataset[key] = value;
      });
    }

    const selectedOption = this.options.find(opt => opt.value === this.selectedValue);
    const selectedLabel = selectedOption?.label ?? this.options[0]?.label ?? '';

    container.innerHTML = `
      <button class="custom-dropdown__trigger" type="button">
        <span class="custom-dropdown__label">${selectedLabel}</span>
        <span class="custom-dropdown__arrow" aria-hidden="true"></span>
      </button>
      <ul class="custom-dropdown__menu" role="listbox">
        ${this.options.map(option => `
          <li
            class="custom-dropdown__item ${option.value === this.selectedValue ? 'custom-dropdown__item--selected' : ''}"
            data-value="${option.value}"
            role="option"
            aria-selected="${option.value === this.selectedValue}"
          >
            ${option.label}
          </li>
        `).join('')}
      </ul>
    `;

    return container;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    const trigger = this.element.querySelector('.custom-dropdown__trigger');
    const items = this.element.querySelectorAll('.custom-dropdown__item');

    // Toggle dropdown
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // Select option
    items.forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const value = (item as HTMLElement).dataset.value;
        if (value) {
          this.selectOption(value);
        }
      });
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (this.isOpen && !this.element.contains(e.target as Node)) {
        this.close();
      }
    });

    // Close on ESC key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });
  }

  /**
   * Toggle dropdown
   */
  private toggle(): void {
    this.isOpen ? this.close() : this.open();
  }

  /**
   * Open dropdown
   */
  private open(): void {
    this.isOpen = true;
    this.element.classList.add('custom-dropdown--open');
  }

  /**
   * Close dropdown
   */
  private close(): void {
    this.isOpen = false;
    this.element.classList.remove('custom-dropdown--open');
  }

  /**
   * Select option
   */
  private selectOption(value: string): void {
    const selectedOption = this.options.find(opt => opt.value === value);
    if (!selectedOption) return;

    this.selectedValue = value;

    // Update label
    const label = this.element.querySelector('.custom-dropdown__label');
    if (label) {
      label.textContent = selectedOption.label;
    }

    // Update selected state
    const items = this.element.querySelectorAll('.custom-dropdown__item');
    items.forEach(item => {
      const itemValue = (item as HTMLElement).dataset.value;
      if (itemValue === value) {
        item.classList.add('custom-dropdown__item--selected');
        item.setAttribute('aria-selected', 'true');
      } else {
        item.classList.remove('custom-dropdown__item--selected');
        item.setAttribute('aria-selected', 'false');
      }
    });

    // Close dropdown
    this.close();

    // Trigger onChange callback
    this.onChange(value);
  }

  /**
   * Get current value
   */
  public getValue(): string {
    return this.selectedValue;
  }

  /**
   * Set value programmatically (does NOT trigger onChange callback)
   */
  public setValue(value: string): void {
    const selectedOption = this.options.find(opt => opt.value === value);
    if (!selectedOption) return;

    this.selectedValue = value;

    // Update label
    const label = this.element.querySelector('.custom-dropdown__label');
    if (label) {
      label.textContent = selectedOption.label;
    }

    // Update selected state
    const items = this.element.querySelectorAll('.custom-dropdown__item');
    items.forEach(item => {
      const itemValue = (item as HTMLElement).dataset.value;
      if (itemValue === value) {
        item.classList.add('custom-dropdown__item--selected');
        item.setAttribute('aria-selected', 'true');
      } else {
        item.classList.remove('custom-dropdown__item--selected');
        item.setAttribute('aria-selected', 'false');
      }
    });

    this.close();
  }

  /**
   * Set a custom display label without changing the selected value
   * Used for showing date ranges like "Mar 1 – Mar 3" while value stays "time-range"
   */
  public setCustomLabel(text: string): void {
    const label = this.element.querySelector('.custom-dropdown__label');
    if (label) {
      label.textContent = text;
    }
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.element.remove();
  }
}
