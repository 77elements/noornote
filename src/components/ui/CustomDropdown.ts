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
  /**
   * Lift the open menu to <body> (position: fixed, anchored to the trigger) so
   * it is not clipped by a scroll-overflow ancestor. Use when the dropdown lives
   * inside a horizontally-scrollable strip or any `overflow: hidden` container
   * (e.g. the scc tab row). Closes on scroll/resize. Not for searchable menus.
   */
  menuPortal?: boolean;
}

export class CustomDropdown {
  private element: HTMLElement;
  private options: DropdownOption[];
  private selectedValue: string;
  private onChange: (value: string) => void;
  private searchable: boolean;
  private menuPortal: boolean;
  private isOpen = false;

  // Portal bookkeeping (only used when menuPortal is set).
  private menuEl: HTMLElement | null = null;
  private triggerEl: HTMLElement | null = null;
  private menuHome: HTMLElement | null = null;

  // Stored so destroy() can detach them — the ISL creates one dropdown per note,
  // so anonymous document listeners would leak on every timeline card recycle.
  private readonly onDocumentClick = (e: MouseEvent): void => {
    const target = e.target as Node;
    if (
      this.isOpen &&
      !this.element.contains(target) &&
      !this.menuEl?.contains(target)
    ) {
      this.close();
    }
  };
  private readonly onDocumentKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) {
      this.close();
    }
  };
  // A portaled menu is anchored to the trigger's viewport position; re-anchor it
  // on scroll/resize. (Closing instead would be killed by unrelated scrolls, e.g.
  // the auto-scrolling system-log panel right next to the scc dropdown.)
  private readonly onPortalReflow = (): void => {
    if (this.isOpen && this.menuPortal) this.positionPortalMenu();
  };

  constructor(config: CustomDropdownOptions) {
    this.options = config.options;
    this.selectedValue = config.selectedValue;
    this.onChange = config.onChange;
    this.searchable = config.searchable ?? false;
    this.menuPortal = config.menuPortal ?? false;
    this.element = this.createElement(config);
    this.setupEventListeners();
  }

  /**
   * Create dropdown structure
   */
  private createElement(config: CustomDropdownOptions): HTMLElement {
    const container = document.createElement('div');
    container.className =
      `custom-dropdown ${this.searchable ? 'custom-dropdown--searchable' : ''} ${config.className || ''}`
        .replace(/\s+/g, ' ')
        .trim();

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

    const selectedOption = this.options.find(
      opt => opt.value === this.selectedValue
    );
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
        ${this.options
          .map(
            option => `
          <li
            class="custom-dropdown__item ${option.value === this.selectedValue ? 'custom-dropdown__item--selected' : ''}"
            data-value="${option.value}"
            role="option"
            aria-selected="${option.value === this.selectedValue}"
          >
            ${option.label}
          </li>
        `
          )
          .join('')}
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
    this.triggerEl = trigger as HTMLElement | null;
    this.menuEl = this.element.querySelector('.custom-dropdown__menu');

    // Toggle dropdown
    trigger?.addEventListener('click', e => {
      e.stopPropagation();
      this.toggle();
    });

    // Select option
    items.forEach(item => {
      item.addEventListener('click', e => {
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
      const input = this.element.querySelector(
        '.custom-dropdown__search-input'
      ) as HTMLInputElement | null;
      input?.addEventListener('click', e => e.stopPropagation());
      input?.addEventListener('keydown', e => e.stopPropagation());
      input?.addEventListener('input', () => this.filterItems(input.value));
    }

    // Close on click outside
    document.addEventListener('click', this.onDocumentClick);

    // Close on ESC key
    document.addEventListener('keydown', this.onDocumentKeydown);
  }

  /** Show only items whose label contains the query (case-insensitive). */
  private filterItems(query: string): void {
    const q = query.trim().toLowerCase();
    this.element.querySelectorAll('.custom-dropdown__item').forEach(item => {
      const label = (item.textContent || '').trim().toLowerCase();
      (item as HTMLElement).style.display =
        !q || label.includes(q) ? '' : 'none';
    });
  }

  /** Clear the search box and unhide all items. */
  private resetFilter(): void {
    if (!this.searchable) return;
    const input = this.element.querySelector(
      '.custom-dropdown__search-input'
    ) as HTMLInputElement | null;
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

    if (this.menuPortal && this.menuEl) {
      // Lift the menu out to <body> so an ancestor's scroll-overflow clip (e.g.
      // the horizontally-scrollable scc tab strip) can't hide it, then anchor it
      // to the trigger with fixed positioning.
      if (!this.menuHome) this.menuHome = this.menuEl.parentElement;
      document.body.appendChild(this.menuEl);
      this.menuEl.classList.add('custom-dropdown__menu--portaled');
      this.positionPortalMenu();
      window.addEventListener('scroll', this.onPortalReflow, true);
      window.addEventListener('resize', this.onPortalReflow);
    } else {
      this.positionMenu();
    }

    if (this.searchable) {
      const input = (this.menuEl ?? this.element).querySelector(
        '.custom-dropdown__search-input'
      ) as HTMLInputElement | null;
      // Focus after the menu becomes visible.
      setTimeout(() => input?.focus(), 0);
    }
  }

  /**
   * Anchor a portaled (position: fixed) menu to the trigger's viewport rect.
   * Drops down / left-aligned by default; flips to right-align or drop-up when
   * that would overflow the viewport.
   */
  private positionPortalMenu(): void {
    const menu = this.menuEl;
    const trigger = this.triggerEl;
    if (!menu || !trigger) return;

    const t = trigger.getBoundingClientRect();
    const m = 8;
    const menuW = menu.offsetWidth;
    const menuH = menu.offsetHeight;

    let top = t.bottom + 4;
    let left = t.left;

    if (left + menuW > window.innerWidth - m) {
      left = Math.max(m, t.right - menuW);
    }
    if (top + menuH > window.innerHeight - m && t.top - menuH - 4 > m) {
      top = t.top - menuH - 4;
    }

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }

  /**
   * Flip the menu toward whichever side/vertical has room. The menu anchors to
   * the trigger's right edge and drops down by default (see SCSS); when that
   * would overflow the viewport we re-anchor left / drop up. Measured after
   * opening, so it adapts to any menu width without hardcoded guesses.
   */
  private positionMenu(): void {
    const menu = this.element.querySelector(
      '.custom-dropdown__menu'
    ) as HTMLElement | null;
    const trigger = this.element.querySelector(
      '.custom-dropdown__trigger'
    ) as HTMLElement | null;
    if (!menu || !trigger) return;

    this.element.classList.remove(
      'custom-dropdown--align-left',
      'custom-dropdown--drop-up'
    );

    const t = trigger.getBoundingClientRect();
    const clip = this.getClipRect();
    const menuW = menu.offsetWidth;
    const menuH = menu.offsetHeight;
    const m = 8;

    // Horizontal: right-anchored by default (menu spans [t.right - menuW, t.right],
    // extending left). If that overflows the LEFT boundary but left-anchoring
    // fits, flip to open rightward. The boundary is the nearest clipping ancestor
    // (e.g. the scrollable `.primary-content` column with overflow-x: hidden), NOT
    // the raw viewport — a menu inside a content column is cut at the column edge,
    // which sits well inside the window (behind the sidebar).
    const rightAnchorFits = t.right - menuW >= clip.left + m;
    const leftAnchorFits = t.left + menuW <= clip.right - m;
    if (!rightAnchorFits && leftAnchorFits) {
      this.element.classList.add('custom-dropdown--align-left');
    }

    // Vertical: drops down by default. If it would clip the bottom and there's
    // room above, drop up instead.
    if (t.bottom + menuH > clip.bottom - m && t.top - menuH > clip.top + m) {
      this.element.classList.add('custom-dropdown--drop-up');
    }
  }

  /**
   * The rectangle the menu must stay inside: the nearest ancestor that actually
   * clips (any non-visible overflow, or paint containment), else the viewport.
   * A dropdown inside a scrollable content column is cut at that column's edge,
   * not the window edge, so collision must be measured against it.
   */
  private getClipRect(): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    let node = this.element.parentElement;
    while (
      node &&
      node !== document.body &&
      node !== document.documentElement
    ) {
      const s = getComputedStyle(node);
      if (
        s.overflowX !== 'visible' ||
        s.overflowY !== 'visible' ||
        s.contain.includes('paint')
      ) {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }
      node = node.parentElement;
    }
    return {
      left: 0,
      right: window.innerWidth,
      top: 0,
      bottom: window.innerHeight,
    };
  }

  /**
   * Close dropdown
   */
  private close(): void {
    this.isOpen = false;
    this.element.classList.remove('custom-dropdown--open');

    if (this.menuPortal && this.menuEl) {
      this.menuEl.classList.remove('custom-dropdown__menu--portaled');
      this.menuEl.style.top = '';
      this.menuEl.style.left = '';
      // Return the menu to its home so the normal descendant CSS applies again.
      if (this.menuHome) this.menuHome.appendChild(this.menuEl);
      window.removeEventListener('scroll', this.onPortalReflow, true);
      window.removeEventListener('resize', this.onPortalReflow);
    }

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
   * Get selected value
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
    document.removeEventListener('click', this.onDocumentClick);
    document.removeEventListener('keydown', this.onDocumentKeydown);
    window.removeEventListener('scroll', this.onPortalReflow, true);
    window.removeEventListener('resize', this.onPortalReflow);
    // A portaled menu lives under <body>; drop it so it doesn't outlive us.
    if (this.menuEl && this.menuEl.parentElement === document.body) {
      this.menuEl.remove();
    }
    this.element.remove();
  }
}
