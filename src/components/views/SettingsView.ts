/**
 * SettingsView Component
 * Menu page linking to individual settings sub-pages
 */

import { View } from './View';
import { PlatformService } from '../../services/PlatformService';
import { Router } from '../../services/Router';

interface SettingsMenuItem {
  label: string;
  route: string;
  platform?: 'desktop' | 'desktop-or-capacitor';
}

const SETTINGS_MENU: SettingsMenuItem[] = [
  { label: 'UI Settings', route: '/settings/ui' },
  {
    label: 'Notification Priorities',
    route: '/settings/notification-priorities',
  },
  { label: 'Relays', route: '/settings/relays' },
  { label: 'Key Signer', route: '/settings/key-signer', platform: 'desktop' },
  { label: 'Media', route: '/settings/media' },
  { label: 'Zaps', route: '/settings/zaps' },
  { label: 'Privacy', route: '/settings/privacy' },
  { label: 'Cache', route: '/settings/cache' },
];

export class SettingsView extends View {
  private container: HTMLElement;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--settings';
    this.render();
  }

  private render(): void {
    const platform = PlatformService.getInstance();

    const menuItems = SETTINGS_MENU.filter(item => {
      if (!item.platform) return true;
      if (item.platform === 'desktop') return platform.isDesktop;
      if (item.platform === 'desktop-or-capacitor')
        return platform.isDesktop || platform.isCapacitor;
      return true;
    });

    const menuHtml = menuItems
      .map(
        item =>
          `<a href="${item.route}" class="nav-list__item">${item.label}<span class="nav-list__chevron" aria-hidden="true"></span></a>`
      )
      .join('');

    const showExportLogs = true;

    this.container.innerHTML = `
      <h1 class="settings-title">Settings</h1>
      <nav class="section">
        ${menuHtml}
      </nav>
      ${
        showExportLogs
          ? `
      <section class="settings-section diagnostic-export-section" style="text-align: center;">
        <button class="btn btn--medium btn--passive" id="export-diagnostic-logs-btn">
          Export DiagLogs
        </button>
      </section>
      `
          : ''
      }
    `;

    // Menu item click handling (use router navigation)
    this.container.querySelectorAll('.nav-list__item').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const route = (e.currentTarget as HTMLAnchorElement).getAttribute(
          'href'
        );
        if (route) Router.getInstance().navigate(route);
      });
    });

    // Diagnostic logs export button
    this.container
      .querySelector('#export-diagnostic-logs-btn')
      ?.addEventListener('click', async e => {
        const btn = e.target as HTMLButtonElement;
        const { runDiagLogExportFromButton } = await import(
          '../../services/DiagLogExportService'
        );
        await runDiagLogExportFromButton(btn, 'Export DiagLogs');
      });
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {}
}
