/**
 * ThemeSwitcher
 * Dropdown for selecting color theme.
 * Mounted in .user-login-bar before FontSizeSwitcher.
 */

import { NnDropdown } from './NnDropdown';
import {
  ThemeService,
  THEMES,
  type ThemeId,
} from '../../services/ThemeService';

export class ThemeSwitcher {
  private element: HTMLElement;
  private dropdown: NnDropdown;

  constructor() {
    const themeService = ThemeService.getInstance();

    this.dropdown = new NnDropdown({
      options: THEMES.map(t => ({ value: t.id, label: t.label })),
      selectedValue: themeService.getTheme(),
      onChange: value => themeService.setTheme(value as ThemeId),
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
