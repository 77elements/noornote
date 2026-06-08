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
 *   searchable: true,
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
  /** Optional type-to-filter search box at the top of the menu (for long lists) */
  searchable?: boolean;
  /** Placeholder for the search box (default "Search…") */
  searchPlaceholder?: string;
  /** Optional data-* attributes as key-value pairs (e.g., { "note-id": "abc123" }) */
  dataAttributes?: Record<string, string>;
}

export class CustomDropdown {
  private element: HTMLElement;
  private options: DropdownOption[];
  private selectedValue: string;
  private onChange: (value: string) => void;
  private searchable: boolean;
  private isOpen = false;

  constructor(config: CustomDropdownOptions) {
    this.options = config.options;
    this.selectedValue = config.selectedValue;
    this.onChange = config.onChange;
    this.searchable = config.searchable ?? false;
    this.element = this.createElement(config);
    this.setupEventListeners();
  }

  /**
   * Create dropdown structure
   */
  private createElement(config: CustomDropdownOptions): HTMLElement {
    const container = document.createElement('div');
    container.className = `custom-dropdown ${this.searchable ? 'custom-dropdown--searchable' : ''} ${config.className || ''}`.replace(/\s+/g, ' ').trim();

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

    const searchHtml = this.searchable
      ? `<li class="custom-dropdown__search"><input type="text" class="custom-dropdown__search-input" placeholder="${config.searchPlaceholder ?? 'Search…'}" /></li>`
      : '';

    container.innerHTML = `
      <button class="custom-dropdown__trigger" type="button">
        <span class="custom-dropdown__label">${selectedLabel}</span>
        <span class="custom-dropdown__arrow" aria-hidden="true"></span>
      </button>
      <ul class="custom-dropdown__menu" role="listbox">
        ${searchHtml}
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
        // Truthy check rejected legitimate empty-string values used by
        // "(default)" / "(none)" entries — picking them was meant to clear
        // the slot, but the click was silently dropped.
        if (value !== undefined) {
          this.selectOption(value);
        }
      });
    });

    // Type-to-filter search (long lists)
    if (this.searchable) {
      const input = this.element.querySelector('.custom-dropdown__search-input') as HTMLInputElement | null;
      input?.addEventListener('click', (e) => e.stopPropagation());
      input?.addEventListener('keydown', (e) => e.stopPropagation());
      input?.addEventListener('input', () => this.filterItems(input.value));
    }

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

  /** Show only items whose label contains the query (case-insensitive). */
  private filterItems(query: string): void {
    const q = query.trim().toLowerCase();
    this.element.querySelectorAll('.custom-dropdown__item').forEach(item => {
      const label = (item.textContent || '').trim().toLowerCase();
      (item as HTMLElement).style.display = !q || label.includes(q) ? '' : 'none';
    });
  }

  /** Clear the search box and unhide all items. */
  private resetFilter(): void {
    if (!this.searchable) return;
    const input = this.element.querySelector('.custom-dropdown__search-input') as HTMLInputElement | null;
    if (input) input.value = '';
    this.element.querySelectorAll('.custom-dropdown__item').forEach(item => {
      (item as HTMLElement).style.display = '';
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
    if (this.searchable) {
      const input = this.element.querySelector('.custom-dropdown__search-input') as HTMLInputElement | null;
      // Focus after the menu becomes visible.
      setTimeout(() => input?.focus(), 0);
    }
  }

  /**
   * Close dropdown
   */
  private close(): void {
    this.isOpen = false;
    this.element.classList.remove('custom-dropdown--open');
    this.resetFilter();
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
