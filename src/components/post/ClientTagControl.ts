/**
 * ClientTagControl Component
 * Per-post custom client tag input for the New Note composer header.
 *
 * Behaviour:
 * - A tag icon button sits in the modal header. Clicking it expands a text
 *   field to its left.
 * - Whatever the user types becomes the note's `client` tag value and OVERRIDES
 *   the global "Sign posts with via NoorNote" UI setting for this one post.
 * - Left empty, the global UI setting applies as before (see AuthService.signEvent).
 */

import { escapeHtml } from '../../helpers/escapeHtml';

export interface ClientTagControlConfig {
  /** Initial value (empty for a fresh composer) */
  initialValue?: string;
  /** Called whenever the field value changes */
  onChange: (value: string) => void;
}

export class ClientTagControl {
  private config: ClientTagControlConfig;
  private value: string;
  private documentClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(config: ClientTagControlConfig) {
    this.config = config;
    this.value = config.initialValue ?? '';
  }

  /**
   * Render control HTML. Input precedes the icon so the field unfolds to the
   * LEFT of the icon when opened.
   */
  public render(): string {
    const hasValue = this.value.trim().length > 0;
    return `
      <div class="post-note-client-tag${hasValue ? ' post-note-client-tag--active' : ''}" data-client-tag>
        <input
          type="text"
          class="post-note-client-tag__input"
          data-client-tag-input
          placeholder="Client tag"
          maxlength="64"
          value="${escapeHtml(this.value)}"
        />
        <button
          type="button"
          class="btn-icon post-note-client-tag__toggle"
          data-client-tag-toggle
          title="Set a custom client tag for this post"
          aria-label="Custom client tag"
        >
          <svg width="18" height="18"><use href="#icon-tag"/></svg>
        </button>
      </div>
    `;
  }

  /**
   * Setup event listeners after rendering
   */
  public setupEventListeners(container: HTMLElement): void {
    // `container` IS the .post-note-client-tag wrapper (data-client-tag lives on it).
    const wrapper = container;
    const toggle = container.querySelector('[data-client-tag-toggle]');
    const input = container.querySelector('[data-client-tag-input]') as HTMLInputElement;

    if (!toggle || !input) return;

    // Toggle the field open/closed on icon click
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = wrapper.classList.toggle('post-note-client-tag--open');
      if (isOpen) {
        input.focus();
        input.select();
      }
    });

    // Track value as the user types
    input.addEventListener('input', () => {
      this.value = input.value;
      wrapper.classList.toggle('post-note-client-tag--active', this.value.trim().length > 0);
      this.config.onChange(this.value);
    });

    // Keep typing inside the field from bubbling to modal-level handlers
    input.addEventListener('click', (e) => e.stopPropagation());

    // Collapse when clicking outside ONLY if the field is empty. With a value
    // set, keep it open so the user can still see/edit their tag.
    this.documentClickHandler = (e: MouseEvent) => {
      if (!wrapper.contains(e.target as Node) && this.value.trim().length === 0) {
        wrapper.classList.remove('post-note-client-tag--open');
      }
    };
    document.addEventListener('click', this.documentClickHandler);
  }

  /**
   * Current trimmed value (empty string = fall back to UI setting)
   */
  public getValue(): string {
    return this.value.trim();
  }

  /**
   * Cleanup event listeners
   */
  public destroy(): void {
    if (this.documentClickHandler) {
      document.removeEventListener('click', this.documentClickHandler);
      this.documentClickHandler = null;
    }
  }
}
