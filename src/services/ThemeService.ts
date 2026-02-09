/**
 * ThemeService
 * Manages color theme preference (global, not per-account).
 * Sets data-theme attribute on <html> for CSS custom property overrides.
 */

export type ThemeId = 'default' | 'bright-superman' | 'code-bunker' | 'soft-lilac' | 'dark-symbiote';

export interface ThemeOption {
  id: ThemeId;
  label: string;
}

export const THEMES: ThemeOption[] = [
  { id: 'default', label: 'Deep Purple' },
  { id: 'bright-superman', label: 'Bright Superman' },
  { id: 'code-bunker', label: 'Code Bunker' },
  { id: 'soft-lilac', label: 'Soft Lilac' },
  { id: 'dark-symbiote', label: 'Dark Symbiote' },
];

const STORAGE_KEY = 'noornote_theme';

export class ThemeService {
  private static instance: ThemeService;
  private currentTheme: ThemeId = 'default';

  private constructor() {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (stored && THEMES.some(t => t.id === stored)) {
      this.currentTheme = stored;
    }
    this.applyTheme();
  }

  public static getInstance(): ThemeService {
    if (!ThemeService.instance) {
      ThemeService.instance = new ThemeService();
    }
    return ThemeService.instance;
  }

  public getTheme(): ThemeId {
    return this.currentTheme;
  }

  public setTheme(themeId: ThemeId): void {
    this.currentTheme = themeId;
    if (themeId === 'default') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, themeId);
    }
    this.applyTheme();
  }

  private applyTheme(): void {
    const html = document.documentElement;
    if (this.currentTheme === 'default') {
      html.removeAttribute('data-theme');
    } else {
      html.setAttribute('data-theme', this.currentTheme);
    }
  }
}
