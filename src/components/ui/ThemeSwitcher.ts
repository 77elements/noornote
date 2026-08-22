/**
 * ThemeSwitcher
 * Dropdown for selecting color theme.
 * Mounted in .user-login-bar before FontSizeSwitcher.
 */

import { CustomDropdown } from './CustomDropdown';
import { ThemeService, THEMES } from '../../services/ThemeService';

export class ThemeSwitcher {
  private element: HTMLElement;
  private dropdown: CustomDropdown;

  constructor() {
    const themeService = ThemeService.getInstance();

    this.dropdown = new CustomDropdown({
      options: THEMES.map(t => ({ value: t.id, label: t.label })),
      selectedValue: themeService.getTheme(),
      onChange: value => themeService.setTheme(value as any),
      className: 'theme-switcher',
    });

    this.element = this.dropdown.getElement();
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.dropdown.destroy();
  }
}
