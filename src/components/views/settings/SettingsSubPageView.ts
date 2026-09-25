/**
 * SettingsSubPageView Base Class
 * Thin wrapper that hosts a SettingsSection as a standalone sub-page
 */

import { View } from '../View';
import type { SettingsSection } from '../../settings/SettingsSection';

export class SettingsSubPageView extends View {
  private container: HTMLElement;
  private section: SettingsSection;

  constructor(title: string, section: SettingsSection) {
    super();
    this.section = section;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--settings';

    // Plain Back lives in the global pcc back bar; its logical-parent fallback
    // routes here to /settings even after a cold deep link.
    this.container.innerHTML = `
      <div class="l-spread">
        <h1 class="settings-title">${title}</h1>
      </div>
      <div id="${section.getSectionId()}-content" class="settings-sub-page__content"></div>
    `;

    this.section.mount(this.container);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.section.unmount();
  }
}
