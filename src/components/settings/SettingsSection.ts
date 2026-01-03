/**
 * SettingsSection Base Class
 * Abstract base for all settings sections in SettingsView
 *
 * @purpose Provides common accordion structure and lifecycle methods
 * @pattern Each section is self-contained with its own mount/unmount logic
 */

export abstract class SettingsSection {
  protected container: HTMLElement;
  protected sectionId: string;

  constructor(sectionId: string) {
    this.sectionId = sectionId;
    this.container = document.createElement('div');
  }

  /**
   * Get the section ID
   */
  public getSectionId(): string {
    return this.sectionId;
  }

  /**
   * Render the accordion section wrapper (title + description)
   * Called by SettingsView to render the section structure
   */
  public renderAccordionSection(
    title: string,
    description: string,
    isOpen: boolean = false
  ): string {
    return `
      <section class="nn-ui-toggle settings-section ${isOpen ? 'open' : ''}" data-section="${this.sectionId}">
        <div class="nn-ui-toggle__header">
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${title}</h2>
            <p class="nn-ui-toggle__description">${description}</p>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content" id="${this.sectionId}-content">
          <!-- Content will be mounted here -->
        </div>
      </section>
    `;
  }

  /**
   * Mount section content into the DOM
   * Called after accordion structure is rendered
   */
  public abstract mount(parentContainer: HTMLElement): void;

  /**
   * Unmount section and cleanup
   * Called when SettingsView is destroyed
   */
  public abstract unmount(): void;

  /**
   * Get the content container element where section content is mounted
   */
  protected getContentContainer(parentContainer: HTMLElement): HTMLElement | null {
    return parentContainer.querySelector(`#${this.sectionId}-content`);
  }
}
