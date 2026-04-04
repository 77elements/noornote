/**
 * SettingsView Component
 * Menu page linking to individual settings sub-pages
 */

import { View } from './View';
import { SyncStatusBadge } from '../shared/SyncStatusBadge';
import { PlatformService } from '../../services/PlatformService';
import { Router } from '../../services/Router';

interface SettingsMenuItem {
  label: string;
  route: string;
  platform?: 'desktop' | 'desktop-or-capacitor';
}

const SETTINGS_MENU: SettingsMenuItem[] = [
  { label: 'UI Settings', route: '/settings/ui' },
  { label: 'Notification Priorities', route: '/settings/notification-priorities' },
  { label: 'Relays', route: '/settings/relays' },
  { label: 'Key Signer', route: '/settings/key-signer', platform: 'desktop' },
  { label: 'Media', route: '/settings/media' },
  { label: 'Zaps', route: '/settings/zaps' },
  { label: 'Privacy', route: '/settings/privacy' },
  { label: 'Cache', route: '/settings/cache', platform: 'desktop' },
];

export class SettingsView extends View {
  private container: HTMLElement;
  private syncStatusBadge: SyncStatusBadge | null = null;

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
      if (item.platform === 'desktop-or-capacitor') return platform.isDesktop || platform.isCapacitor;
      return true;
    });

    const menuHtml = menuItems.map(item =>
      `<a href="${item.route}" class="settings-menu__item">${item.label}</a>`
    ).join('');

    const showExportLogs = platform.isDesktop || platform.isCapacitor;

    this.container.innerHTML = `
      <div class="settings-container">
        <h1 class="settings-title">Settings</h1>
        <div id="sync-status-badge-container" class="sync-status-container"></div>
        <nav class="settings-menu">
          ${menuHtml}
        </nav>
        ${showExportLogs ? `
        <section class="settings-section diagnostic-export-section" style="text-align: center;">
          <button class="btn btn--medium btn--passive" id="export-diagnostic-logs-btn">
            Export Logs
          </button>
        </section>
        ` : ''}
      </div>
    `;

    // Menu item click handling (use router navigation)
    this.container.querySelectorAll('.settings-menu__item').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const route = (e.currentTarget as HTMLAnchorElement).getAttribute('href');
        if (route) Router.getInstance().navigate(route);
      });
    });

    // Diagnostic logs export button
    this.container.querySelector('#export-diagnostic-logs-btn')?.addEventListener('click', async (e) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Exporting...';
      try {
        const { exportDiagnosticLogs } = await import('../../services/DiagLogExportService');
        const { DiagnosticLogger } = await import('../../services/DiagnosticLogger');
        const status = DiagnosticLogger.getInstance().getStatus();
        const { ToastService } = await import('../../services/ToastService');

        if (!status.initialized && !PlatformService.getInstance().isCapacitor) {
          const reason = status.error || 'Logger not initialized';
          ToastService.show(`DiagLog: ${reason}`, 'error', 8000);
          return;
        }

        let exportError: string | null = null;
        let success = false;
        try {
          success = await exportDiagnosticLogs();
        } catch (e) {
          exportError = String(e);
        }

        if (success) {
          ToastService.show('Logs exported', 'success');
        } else {
          const debugInfo = (exportDiagnosticLogs as any).lastDebugInfo || '';
          ToastService.show(exportError || debugInfo || 'export returned false', 'error', 15000);
        }
      } catch (error) {
        const { ToastService } = await import('../../services/ToastService');
        ToastService.show(`Import error: ${error}`, 'error', 15000);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Export Logs';
      }
    });

    // Sync status badge
    const badgeContainer = this.container.querySelector('#sync-status-badge-container');
    if (badgeContainer) {
      this.syncStatusBadge = new SyncStatusBadge(badgeContainer as HTMLElement);
      this.syncStatusBadge.subscribeToSyncStatus();
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.syncStatusBadge) {
      this.syncStatusBadge.destroy();
      this.syncStatusBadge = null;
    }
  }
}
