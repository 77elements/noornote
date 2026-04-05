/**
 * SettingsSubPageView Base Class
 * Thin wrapper that hosts a SettingsSection as a standalone sub-page
 */

import { View } from '../View';
import { Router } from '../../../services/Router';
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
      <div class="l-spread">
        <h1 class="settings-title">${title}</h1>
        <button class="btn btn--medium btn--passive settings-sub-page__back"><span class="back-chevron" aria-hidden="true"></span> Back</button>
      </div>
      <div id="${section.getSectionId()}-content" class="settings-sub-page__content"></div>
    `;

    this.container.querySelector('.settings-sub-page__back')?.addEventListener('click', () => {
      Router.getInstance().navigate('/settings');
    });

    this.section.mount(this.container);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.section.unmount();
  }
}
