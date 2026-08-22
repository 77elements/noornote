/**
 * Switch Component
 * Reusable toggle switch with label
 *
 * Usage:
 * ```typescript
 * const nsfwSwitch = new Switch({
 *   label: 'NSFW',
 *   checked: false,
 *   onChange: (checked) => console.debug('NSFW:', checked)
 * });
 * container.innerHTML = nsfwSwitch.render();
 * nsfwSwitch.setupEventListeners(container);
 * ```
 */

export interface SwitchConfig {
  /** Label text displayed next to switch */
  label: string;
  /** Initial checked state */
  checked: boolean;
  /** Callback when switch state changes */
  onChange: (checked: boolean) => void;
  /** Optional unique ID (auto-generated if not provided) */
  id?: string;
}

export class Switch {
  private config: SwitchConfig;
  private checked: boolean;
  private id: string;

  constructor(config: SwitchConfig) {
    this.config = config;
    this.checked = config.checked;
    this.id = config.id || `switch-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Render switch HTML
   */
  public render(): string {
    return `
      <div class="switch-container">
        <label class="switch-label">
          <span class="switch-text">${this.config.label}</span>
          <div class="switch-toggle">
            <input
              type="checkbox"
              id="${this.id}"
              class="switch-input"
              ${this.checked ? 'checked' : ''}
            />
            <span class="switch-slider"></span>
          </div>
        </label>
      </div>
    `;
  }

  /**
   * Setup event listeners after rendering
   */
  public setupEventListeners(container: HTMLElement): void {
    const input = container.querySelector(`#${this.id}`) as HTMLInputElement;
    if (!input) return;

    input.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      this.checked = target.checked;
      this.config.onChange(this.checked);
    });
  }

  /**
   * Get current checked state
   */
  public isChecked(): boolean {
    return this.checked;
  }

  /**
   * Set checked state programmatically
   */
  public setChecked(checked: boolean): void {
    this.checked = checked;
    const input = document.querySelector(`#${this.id}`) as HTMLInputElement;
    if (input) {
      input.checked = checked;
    }
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    const input = document.querySelector(`#${this.id}`) as HTMLInputElement;
    if (input) {
      input.removeEventListener('change', () => {});
    }
  }
}
