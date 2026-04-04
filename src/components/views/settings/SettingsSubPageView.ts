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

    this.container.innerHTML = `
      <div class="settings-container">
        <div class="settings-sub-page__header">
          <a href="/settings" class="settings-sub-page__back">
            <svg width="18" height="18"><use href="#icon-back"/></svg>
          </a>
          <h1 class="settings-title">${title}</h1>
        </div>
        <div id="${section.getSectionId()}-content" class="settings-sub-page__content"></div>
      </div>
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
